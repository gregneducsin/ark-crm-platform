import { recordSmsDeliveryReceipt, type SmsInboundMetadata } from "./sms-delivery.service.js";
import { desc, eq, sql } from "drizzle-orm";
import { db, customersTable, conversationsTable, supportConversationsTable, conversationMessagesTable, supportConversationMessagesTable } from "@luma/db";
import { ibluSendMessageReceivedDataSchema, ibluSendMessageFailedDataSchema, type IbluSendWebhookEnvelope } from "@luma/shared";
import { recordWebhookEventIfNew, markWebhookEventProcessed, markWebhookEventFailed } from "./webhooks.service.js";
import { processInboundMessage } from "./alexis-dispatch.service.js";
import { processInboundSupportMessage } from "./sophie-dispatch.service.js";
import { recordAndClassifyUnmatchedSms } from "./unmatched-inbound-sms.service.js";
import { phoneMatchKey } from "../lib/phone.js";
import { recordPhoneSmsOptOut } from "../lib/sms-opt-out.js";
import { interactivePreCheck } from "../lib/messaging/safety.js";
import { logger } from "../lib/logger.js";
import { notifySmsSlack } from "../lib/slack.js";

// Matches on the last 10 digits rather than an exact string — phone numbers
// written before phone normalization existed (or entered by hand) may be
// stored as bare 10-digit strings, with dashes, or without a country code,
// while iBluSend always sends E.164 ("+1..."). An exact-match lookup here
// silently misses those real customers, which is exactly how a real
// inbound text from an existing customer went unanswered.
//
// Two customer records can legitimately share a phone number — e.g. an old
// test/lead signup left the same number on file as a since-purchased
// customer. Without a tiebreaker this matched an arbitrary row (whichever
// Postgres happened to return), which once sent a real customer's "thank
// you" reply to a stale unsold-lead record — Sophie's support conversation
// never saw it, and Alexis answered as if they hadn't purchased yet. Prefer
// whichever match already has a support conversation: per
// dispatchInboundMessage below, that only exists off a real purchase, so it
// identifies which of several same-number records this text actually
// belongs to today. Among ties, prefer the most recently created record.
async function findCustomerIdByPhone(phone: string): Promise<string | undefined> {
  const key = phoneMatchKey(phone);
  if (key.length !== 10) return undefined;
  const [row] = await db
    .select({ id: customersTable.id })
    .from(customersTable)
    .leftJoin(supportConversationsTable, eq(supportConversationsTable.personId, customersTable.id))
    .where(sql`right(regexp_replace(${customersTable.phone}, '\D', '', 'g'), 10) = ${key}`)
    .orderBy(sql`${supportConversationsTable.id} is null`, sql`${customersTable.createdAt} desc`)
    .limit(1);
  return row?.id;
}

async function hasSupportConversation(personId: string): Promise<boolean> {
  const [row] = await db.select({ id: supportConversationsTable.id }).from(supportConversationsTable).where(eq(supportConversationsTable.personId, personId));
  return Boolean(row);
}

/** How long after we send something we'll still treat an identical "incoming" event as a possible echo of it, rather than real customer input. */
const ECHO_WINDOW_MS = 3 * 60 * 1000;

type LastMessage = { direction: "inbound" | "outbound"; body: string; createdAt: Date } | undefined;

function isRecentOutboundMatch(last: LastMessage, normalizedIncoming: string): boolean {
  if (!last || last.direction !== "outbound") return false;
  if (last.body.trim() !== normalizedIncoming) return false;
  return Date.now() - new Date(last.createdAt).getTime() <= ECHO_WINDOW_MS;
}

/**
 * Some iBluSend/device setups appear to redeliver our own just-sent outbound
 * text back through message.received with direction "incoming" — confirmed
 * against a real incident on Luma where the bot ended up replying to its own
 * messages in a self-feeding loop, producing a dozen-plus unrelated-looking
 * texts to one customer in a couple of minutes. Each redelivery carries a
 * genuinely new event_id, so the ordinary dedup in handleIbluSendWebhook
 * doesn't catch it — this is a distinct check: does this "inbound" text
 * exactly match the most recent thing WE sent this person, within a window
 * where a real customer coincidentally typing back the bot's own wording
 * verbatim is not a realistic possibility. Scoped to known customers
 * (Alexis/Sophie's own conversations) — the unmatched-inbound pipeline
 * doesn't hit this path.
 */
async function isLikelyOutboundEcho(personId: string, body: string): Promise<boolean> {
  const normalized = body.trim();
  if (!normalized) return false;

  if (await hasSupportConversation(personId)) {
    const [conversation] = await db.select({ id: supportConversationsTable.id }).from(supportConversationsTable).where(eq(supportConversationsTable.personId, personId));
    if (!conversation) return false;
    const [last] = await db
      .select({ direction: supportConversationMessagesTable.direction, body: supportConversationMessagesTable.body, createdAt: supportConversationMessagesTable.createdAt })
      .from(supportConversationMessagesTable)
      .where(eq(supportConversationMessagesTable.conversationId, conversation.id))
      .orderBy(desc(supportConversationMessagesTable.createdAt))
      .limit(1);
    return isRecentOutboundMatch(last, normalized);
  }

  const [conversation] = await db.select({ id: conversationsTable.id }).from(conversationsTable).where(eq(conversationsTable.personId, personId));
  if (!conversation) return false;
  const [last] = await db
    .select({ direction: conversationMessagesTable.direction, body: conversationMessagesTable.body, createdAt: conversationMessagesTable.createdAt })
    .from(conversationMessagesTable)
    .where(eq(conversationMessagesTable.conversationId, conversation.id))
    .orderBy(desc(conversationMessagesTable.createdAt))
    .limit(1);
  return isRecentOutboundMatch(last, normalized);
}

/**
 * Decides which bot owns a real inbound text. A support conversation only
 * ever gets created off a real purchase/order event (see
 * getOrCreateSupportConversation's callers in order-fulfillment.service.ts)
 * — its mere existence means this person is a customer, not just a lead, so
 * Sophie owns anything from them from that point on, even if Alexis's
 * conversation is technically still open too. Falls back to Alexis otherwise,
 * whether or not a Alexis conversation already exists — findCustomerIdByPhone
 * (the only way personId ever gets here) already confirms this is a real,
 * known customer/lead, not a stranger, so a first-ever inbound text from
 * them starts a Alexis conversation the same way any other automated trigger
 * in this codebase creates one unattended (processInboundMessage calls
 * getOrCreateConversation itself). Staying silent here left a known
 * customer's real message unanswered for no reason other than nobody having
 * texted them first.
 */
async function dispatchInboundMessage(personId: string, body: string, mediaUrls: string[] | undefined, metadata: SmsInboundMetadata): Promise<void> {
  if (await hasSupportConversation(personId)) {
    await processInboundSupportMessage(personId, body, mediaUrls, metadata);
  } else {
    await processInboundMessage(personId, body, undefined, mediaUrls, metadata);
  }
}

/**
 * Incoming messages preserve provider IDs and event times. Delivery receipts are
 * durable and reconciled even if they precede the synchronous send response.
 * Unknown event types are acknowledged. event_id deduplicates webhook retries.
 */
export async function handleIbluSendWebhook(envelope: IbluSendWebhookEnvelope): Promise<{ duplicate: boolean }> {
  const recorded = await recordWebhookEventIfNew("iblusend_message", envelope.event_id, envelope);
  if (!recorded) return { duplicate: true };

  try {
    if (envelope.event === "message.received") {
      const parsed = ibluSendMessageReceivedDataSchema.safeParse(envelope.data);
      if (!parsed.success) {
        throw new Error(`message.received payload failed validation: ${parsed.error.message}`);
      }
      const data = parsed.data;
      if (!Number.isFinite(new Date(envelope.timestamp).getTime())) throw new Error("Invalid inbound SMS timestamp");
      const mediaUrls = data.media_urls && data.media_urls.length > 0 ? data.media_urls : undefined;
      // A picture-only text (no caption) arrives with content null/empty —
      // previously dropped entirely, since this whole branch only fired on
      // truthy content. body still can't be null (conversation_messages.body
      // is NOT NULL, and every downstream reader — Alexis/Sophie's own
      // prompts included — expects real text), so a picture with no caption
      // gets a fixed placeholder instead; the actual image is what mediaUrls
      // is for.
      if (data.direction === "incoming" && (data.content || mediaUrls)) {
        const body = data.content || "[Image attached]";
        const personId = await findCustomerIdByPhone(data.phone_number);
        if (personId) {
          if (await isLikelyOutboundEcho(personId, body)) {
            logger.warn(
              { personId, phoneLastFour: data.phone_number.slice(-4) },
              "message.received content matches our own recent outbound message — treating as a provider/device echo, not real inbound, and not replying to it",
            );
            void notifySmsSlack(
              "Ignored a likely self-echoed SMS (iBluSend/device redelivered our own outbound text as inbound) — if this keeps happening, check the RCS/device config on that number with iBluSend.",
            );
            await markWebhookEventProcessed(recorded.id, personId);
            return { duplicate: false };
          }
          await dispatchInboundMessage(personId, body, mediaUrls, { providerMessageId: data.message_id, createdAt: new Date(envelope.timestamp) });
          await markWebhookEventProcessed(recorded.id, personId);
          return { duplicate: false };
        }
        // No matching customer — record/classify/ack it instead of dropping
        // it silently. See unmatched-inbound-sms.service.ts.
        // Persist STOP outside the best-effort onboarding catch. A database
        // failure must fail the webhook so the provider can retry it.
        const pre = interactivePreCheck(body);
        if (pre.blocked && pre.code === "OPT_OUT") await recordPhoneSmsOptOut(data.phone_number);
        try {
          await recordAndClassifyUnmatchedSms(data.phone_number, body, mediaUrls, { providerMessageId: data.message_id, createdAt: new Date(envelope.timestamp) });
        } catch (err) {
          logger.warn(
            { phoneLastFour: data.phone_number.slice(-4), reason: err instanceof Error ? err.message : String(err) },
            "recordAndClassifyUnmatchedSms failed",
          );
        }
      }
    } else if (["message.sent", "message.delivered", "message.read", "message.failed"].includes(envelope.event)) {
      const parsed = ibluSendMessageFailedDataSchema.safeParse(envelope.data);
      if (!parsed.success) throw new Error("Delivery receipt missing message_id");
      const occurredAt = new Date(envelope.timestamp);
      if (!Number.isFinite(occurredAt.getTime())) throw new Error("Invalid delivery receipt timestamp");
      const found = await recordSmsDeliveryReceipt(parsed.data.message_id, envelope.event.slice(8) as "sent" | "delivered" | "read" | "failed", occurredAt);
      if (envelope.event === "message.failed" && found) void notifySmsSlack(`SMS ${parsed.data.message_id} failed at the provider. Review the conversation before resending.`);
    }
    await markWebhookEventProcessed(recorded.id);
  } catch (err) {
    await markWebhookEventFailed(recorded.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { duplicate: false };
}
