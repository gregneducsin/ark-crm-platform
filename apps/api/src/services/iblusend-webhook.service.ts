import { eq, sql } from "drizzle-orm";
import { db, customersTable, supportConversationsTable, conversationMessagesTable, supportConversationMessagesTable, unmatchedSmsMessagesTable } from "@luma/db";
import { ibluSendMessageReceivedDataSchema, ibluSendMessageFailedDataSchema, type IbluSendWebhookEnvelope } from "@luma/shared";
import { recordWebhookEventIfNew, markWebhookEventProcessed, markWebhookEventFailed } from "./webhooks.service.js";
import { processInboundMessage } from "./alexis-dispatch.service.js";
import { processInboundSupportMessage } from "./sophie-dispatch.service.js";
import { recordAndClassifyUnmatchedSms } from "./unmatched-inbound-sms.service.js";
import { phoneMatchKey } from "../lib/phone.js";
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

/**
 * Retroactively flags a message "failed" after we'd already recorded it as
 * sent — see message.failed handling below. A send only ever looks like it
 * succeeded because iBluSend's synchronous API response doesn't guarantee
 * carrier delivery; this is the async correction for when it turns out it
 * didn't go through. Tries each of the three tables a text can land in, in
 * turn, since the message_id alone doesn't say which one it came from —
 * stops at the first match, since a given provider message id only ever
 * belongs to one outbound row.
 */
async function markMessageFailedByProviderMessageId(messageId: string): Promise<boolean> {
  const [conversationRow] = await db
    .update(conversationMessagesTable)
    .set({ deliveryStatus: "failed" })
    .where(eq(conversationMessagesTable.providerMessageId, messageId))
    .returning({ id: conversationMessagesTable.id });
  if (conversationRow) return true;

  const [supportRow] = await db
    .update(supportConversationMessagesTable)
    .set({ deliveryStatus: "failed" })
    .where(eq(supportConversationMessagesTable.providerMessageId, messageId))
    .returning({ id: supportConversationMessagesTable.id });
  if (supportRow) return true;

  const [unmatchedRow] = await db
    .update(unmatchedSmsMessagesTable)
    .set({ deliveryStatus: "failed" })
    .where(eq(unmatchedSmsMessagesTable.providerMessageId, messageId))
    .returning({ id: unmatchedSmsMessagesTable.id });
  return Boolean(unmatchedRow);
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
async function dispatchInboundMessage(personId: string, body: string, mediaUrls?: string[]): Promise<void> {
  // Only pass the trailing mediaUrls arg through when it's actually present
  // — an explicit `undefined` positional argument is still a real arg as
  // far as a caller-args assertion in a test is concerned, so this keeps
  // the ordinary, by-far-more-common text-only call exactly as it always
  // was rather than silently growing every call's arg count.
  if (await hasSupportConversation(personId)) {
    if (mediaUrls) await processInboundSupportMessage(personId, body, mediaUrls);
    else await processInboundSupportMessage(personId, body);
    return;
  }
  if (mediaUrls) await processInboundMessage(personId, body, undefined, mediaUrls);
  else await processInboundMessage(personId, body);
}

/**
 * Handles one iBluSend webhook delivery. "message.received" with direction
 * "incoming" triggers a bot turn; "message.failed" retroactively flags a
 * message we'd already recorded as sent (see
 * markMessageFailedByProviderMessageId — a provider's synchronous "OK"
 * doesn't guarantee the carrier actually delivered it). Every other event
 * type (message.sent/delivered/read, reactions, contact/device events) is
 * acknowledged and otherwise ignored — iBluSend auto-disables an endpoint
 * after 3 consecutive non-2xx responses, so an event type we don't act on
 * yet must still resolve to a clean ack, not an error.
 *
 * event_id (not data.message_id) is the idempotency key — iBluSend's docs:
 * delivery is at-least-once and event_id is "unique per occurrence and
 * stable across retries."
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
          await dispatchInboundMessage(personId, body, mediaUrls);
          await markWebhookEventProcessed(recorded.id, personId);
          return { duplicate: false };
        }
        // No matching customer — record/classify/ack it instead of dropping
        // it silently. See unmatched-inbound-sms.service.ts.
        try {
          // Same reasoning as dispatchInboundMessage — only pass mediaUrls
          // when actually present, so the ordinary text-only call keeps its
          // existing 2-arg shape.
          if (mediaUrls) await recordAndClassifyUnmatchedSms(data.phone_number, body, mediaUrls);
          else await recordAndClassifyUnmatchedSms(data.phone_number, body);
        } catch (err) {
          logger.warn(
            { phoneLastFour: data.phone_number.slice(-4), reason: err instanceof Error ? err.message : String(err) },
            "recordAndClassifyUnmatchedSms failed",
          );
        }
      }
    } else if (envelope.event === "message.failed") {
      const parsed = ibluSendMessageFailedDataSchema.safeParse(envelope.data);
      if (!parsed.success) {
        throw new Error(`message.failed payload failed validation: ${parsed.error.message}`);
      }
      const found = await markMessageFailedByProviderMessageId(parsed.data.message_id);
      if (found) {
        // This is worse than a send that failed loudly at send time (already
        // Slack-alerted elsewhere) — this one looked fine, staff may already
        // be assuming the customer got it, and now it turns out they didn't.
        void notifySmsSlack(`An SMS previously recorded as sent actually failed to deliver (iBluSend message_id ${parsed.data.message_id}).`);
      } else {
        logger.warn({ messageId: parsed.data.message_id }, "message.failed webhook: no matching outbound message found for this provider message id");
      }
    }
    await markWebhookEventProcessed(recorded.id);
  } catch (err) {
    await markWebhookEventFailed(recorded.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { duplicate: false };
}
