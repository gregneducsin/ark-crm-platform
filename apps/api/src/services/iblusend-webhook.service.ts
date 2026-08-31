import { eq, sql } from "drizzle-orm";
import { db, customersTable, supportConversationsTable } from "@luma/db";
import { ibluSendMessageReceivedDataSchema, type IbluSendWebhookEnvelope } from "@luma/shared";
import { recordWebhookEventIfNew, markWebhookEventProcessed, markWebhookEventFailed } from "./webhooks.service.js";
import { processInboundMessage } from "./alexis-dispatch.service.js";
import { processInboundSupportMessage } from "./sophie-dispatch.service.js";
import { recordAndClassifyUnmatchedSms } from "./unmatched-inbound-sms.service.js";
import { phoneMatchKey } from "../lib/phone.js";
import { logger } from "../lib/logger.js";

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
async function dispatchInboundMessage(personId: string, body: string): Promise<void> {
  if (await hasSupportConversation(personId)) {
    await processInboundSupportMessage(personId, body);
    return;
  }
  await processInboundMessage(personId, body);
}

/**
 * Handles one iBluSend webhook delivery. Only "message.received" with
 * direction "incoming" triggers a bot turn; every other event type
 * (delivery receipts, reactions, contact/device events) is acknowledged and
 * otherwise ignored — iBluSend auto-disables an endpoint after 3
 * consecutive non-2xx responses, so an event type we don't act on yet must
 * still resolve to a clean ack, not an error.
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
      if (data.direction === "incoming" && data.content) {
        const personId = await findCustomerIdByPhone(data.phone_number);
        if (personId) {
          await dispatchInboundMessage(personId, data.content);
          await markWebhookEventProcessed(recorded.id, personId);
          return { duplicate: false };
        }
        // No matching customer — record/classify/ack it instead of dropping
        // it silently. See unmatched-inbound-sms.service.ts.
        try {
          await recordAndClassifyUnmatchedSms(data.phone_number, data.content);
        } catch (err) {
          logger.warn(
            { phoneLastFour: data.phone_number.slice(-4), reason: err instanceof Error ? err.message : String(err) },
            "recordAndClassifyUnmatchedSms failed",
          );
        }
      }
    }
    await markWebhookEventProcessed(recorded.id);
  } catch (err) {
    await markWebhookEventFailed(recorded.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { duplicate: false };
}
