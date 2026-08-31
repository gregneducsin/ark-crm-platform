import { and, eq, lt, lte, or, sql } from "drizzle-orm";
import { db, customersTable, reviewRequestTriggersTable } from "@luma/db";
import { getOrCreateSupportConversation, appendSupportMessage, updateSupportConversationState } from "./support-conversations.service.js";
import { getOrCreateSupportEmailConversation, appendSupportEmailMessage } from "./support-email-conversations.service.js";
import { getSmsProvider } from "../lib/sms-provider.js";
import {
  renderOrderReceivedMessage,
  renderRefillOrderReceivedMessage,
  renderPrescriptionWrittenMessage,
  renderOrderShippedMessage,
  renderReviewRequestMessage,
  renderPaymentFailedFirstOrderMessage,
  renderPaymentFailedRecurringMessage,
} from "../lib/support/templates.js";
import {
  renderOrderReceivedEmail,
  renderRefillOrderReceivedEmail,
  renderPrescriptionWrittenEmail,
  renderOrderShippedEmail,
  renderPaymentFailedFirstOrderEmail,
  renderPaymentFailedRecurringEmail,
} from "../lib/email/templates.js";
import { sendTriggerEmail } from "../lib/email/send-trigger-email.js";
import { logger } from "../lib/logger.js";
import { isCustomerSmsDnd } from "./dnd.service.js";

/**
 * There's no explicit "delivered" signal from Bask, so the review check-in
 * fires a fixed delay after the order-shipped event rather than off a real
 * delivery-confirmation webhook — same fixed-delay-off-the-last-known-event
 * pattern as the abandoned-cart opener. Owner-set to 11 days from shipping.
 */
const REVIEW_REQUEST_DELAY_MS = 11 * 24 * 60 * 60 * 1000;

/**
 * A failed send (SMS provider timeout, no phone on file yet, etc.) gets a
 * few more chances rather than being lost the moment it first fails — up to
 * MAX_SEND_ATTEMPTS total attempts, each at least RETRY_COOLDOWN_MS apart so
 * a flapping provider isn't hammered. After the cap, the row stays "failed"
 * permanently, same as before this retry mechanism existed.
 */
const MAX_SEND_ATTEMPTS = 3;
const RETRY_COOLDOWN_MS = 30 * 60 * 1000;

async function getCustomerContact(personId: string): Promise<{ firstName: string; phone: string | null; email: string } | undefined> {
  const [row] = await db
    .select({ firstName: customersTable.firstName, phone: customersTable.phone, email: customersTable.email })
    .from(customersTable)
    .where(eq(customersTable.id, personId));
  return row;
}

/**
 * Sends the order-received opener immediately — no sweep, no delay, same
 * "fire instantly" pattern as the Meta lead opener. Called synchronously
 * from handleBaskOrderWebhook. Failures are caught and logged, never thrown.
 */
export async function sendOrderReceivedOpener(personId: string): Promise<void> {
  const customer = await getCustomerContact(personId);
  if (!customer) {
    logger.warn({ personId }, "order-received opener not sent: customer not found");
    return;
  }

  const conversation = await getOrCreateSupportConversation(personId);
  const dnd = await isCustomerSmsDnd(personId);
  if (customer.phone && !dnd) {
    const text = renderOrderReceivedMessage(customer.firstName);
    try {
      const result = await getSmsProvider().sendMessage(customer.phone, text);
      await appendSupportMessage(conversation.id, "outbound", text, { providerMessageId: result.providerMessageId });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ personId, reason }, "order-received opener send failed");
      await appendSupportMessage(conversation.id, "outbound", text, {});
    }
  } else {
    logger.warn({ personId, reason: dnd ? "do_not_disturb" : "no_phone_number" }, "order-received opener SMS not sent");
  }

  const emailConversation = await getOrCreateSupportEmailConversation(personId);
  await sendTriggerEmail({
    persona: "sophie",
    personId,
    conversationId: emailConversation.id,
    email: customer.email,
    render: (unsubscribeUrl) => renderOrderReceivedEmail(customer.firstName, unsubscribeUrl),
    appendMessage: appendSupportEmailMessage,
    logLabel: "order-received",
  });
}

/**
 * Refill-order counterpart to sendOrderReceivedOpener — fires for a
 * recurring order instead of the first-order welcome, since re-sending that
 * welcome copy to a returning customer reads as broken. Without this, a
 * recurring order previously got no notice at all until prescription-written
 * or order-shipped fired later. Same instant-send, fail-soft shape.
 */
export async function sendRefillOrderReceivedNotice(personId: string): Promise<void> {
  const customer = await getCustomerContact(personId);
  if (!customer) {
    logger.warn({ personId }, "refill order-received notice not sent: customer not found");
    return;
  }

  const conversation = await getOrCreateSupportConversation(personId);
  const dnd = await isCustomerSmsDnd(personId);
  if (customer.phone && !dnd) {
    const text = renderRefillOrderReceivedMessage(customer.firstName);
    try {
      const result = await getSmsProvider().sendMessage(customer.phone, text);
      await appendSupportMessage(conversation.id, "outbound", text, { providerMessageId: result.providerMessageId });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ personId, reason }, "refill order-received notice send failed");
      await appendSupportMessage(conversation.id, "outbound", text, {});
    }
  } else {
    logger.warn({ personId, reason: dnd ? "do_not_disturb" : "no_phone_number" }, "refill order-received notice SMS not sent");
  }

  const emailConversation = await getOrCreateSupportEmailConversation(personId);
  await sendTriggerEmail({
    persona: "sophie",
    personId,
    conversationId: emailConversation.id,
    email: customer.email,
    render: (unsubscribeUrl) => renderRefillOrderReceivedEmail(customer.firstName, unsubscribeUrl),
    appendMessage: appendSupportEmailMessage,
    logLabel: "refill-order-received",
  });
}

/** Fired synchronously from the prescription-written webhook handler. */
export async function handlePrescriptionWritten(personId: string): Promise<void> {
  const customer = await getCustomerContact(personId);
  const conversation = await getOrCreateSupportConversation(personId);
  await updateSupportConversationState(conversation.id, { prescriptionWritten: true, prescriptionWrittenAt: new Date() });

  const dnd = await isCustomerSmsDnd(personId);
  if (customer?.phone && !dnd) {
    const text = renderPrescriptionWrittenMessage(customer.firstName);
    try {
      const result = await getSmsProvider().sendMessage(customer.phone, text);
      await appendSupportMessage(conversation.id, "outbound", text, { providerMessageId: result.providerMessageId });
    } catch (err) {
      logger.warn({ personId, reason: err instanceof Error ? err.message : String(err) }, "prescription-written notice send failed");
      await appendSupportMessage(conversation.id, "outbound", text, {});
    }
  } else {
    logger.warn({ personId, reason: dnd ? "do_not_disturb" : "no_phone_number" }, "prescription-written notice not sent");
  }

  if (customer) {
    const emailConversation = await getOrCreateSupportEmailConversation(personId);
    await sendTriggerEmail({
      persona: "sophie",
      personId,
      conversationId: emailConversation.id,
      email: customer.email,
      render: (unsubscribeUrl) => renderPrescriptionWrittenEmail(customer.firstName, unsubscribeUrl),
      appendMessage: appendSupportEmailMessage,
      logLabel: "prescription-written",
    });
  }
}

/**
 * Fired synchronously from the order-shipped webhook handler. Also arms the
 * post-delivery review check-in.
 */
export async function handleOrderShipped(personId: string, trackingNumber: string): Promise<void> {
  const customer = await getCustomerContact(personId);
  const conversation = await getOrCreateSupportConversation(personId);
  await updateSupportConversationState(conversation.id, { orderShipped: true, orderShippedAt: new Date(), trackingNumber });

  const dnd = await isCustomerSmsDnd(personId);
  if (customer?.phone && !dnd) {
    const text = renderOrderShippedMessage(customer.firstName, trackingNumber);
    try {
      const result = await getSmsProvider().sendMessage(customer.phone, text);
      await appendSupportMessage(conversation.id, "outbound", text, { providerMessageId: result.providerMessageId });
    } catch (err) {
      logger.warn({ personId, reason: err instanceof Error ? err.message : String(err) }, "order-shipped notice send failed");
      await appendSupportMessage(conversation.id, "outbound", text, {});
    }
  } else {
    logger.warn({ personId, reason: dnd ? "do_not_disturb" : "no_phone_number" }, "order-shipped notice not sent");
  }

  if (customer) {
    const emailConversation = await getOrCreateSupportEmailConversation(personId);
    await sendTriggerEmail({
      persona: "sophie",
      personId,
      conversationId: emailConversation.id,
      email: customer.email,
      render: (unsubscribeUrl) => renderOrderShippedEmail(customer.firstName, trackingNumber, unsubscribeUrl),
      appendMessage: appendSupportEmailMessage,
      logLabel: "order-shipped",
    });
  }

  await db
    .insert(reviewRequestTriggersTable)
    .values({ personId, dueAt: new Date(Date.now() + REVIEW_REQUEST_DELAY_MS) })
    .onConflictDoNothing({ target: reviewRequestTriggersTable.personId });
}

/**
 * Fired synchronously from the payment-failed webhook handler, once it's
 * flipped the matching purchase off "completed" (see handleBaskPaymentFailedWebhook).
 * Corrects course after handleBaskOrderWebhook already sent the
 * "we received your order" notice the instant the order landed, before
 * payment was confirmed — the patient gets a second, honest message instead
 * of being left thinking their order is progressing normally, and the
 * conversation is flagged for a person to actually help them complete
 * payment (this is deliberately staff-assisted, not self-service — see
 * renderPaymentFailedFirstOrderEmail's docstring for why there's no
 * retry-payment link).
 *
 * isFirstOrder picks the copy: owner-specified that a first order should go
 * straight to "reply and we'll help," since there's no existing relationship
 * to check in on, while a recurring/refill order asks first whether the
 * patient still wants to move forward.
 *
 * Only updates the SMS-side support_conversations row, not its email twin —
 * matching the existing prescriptionWritten/orderShipped precedent above,
 * which is SMS-only for the same reason (not something this change expands
 * or fixes).
 */
export async function handlePaymentFailed(personId: string, isFirstOrder: boolean): Promise<void> {
  const customer = await getCustomerContact(personId);
  const conversation = await getOrCreateSupportConversation(personId);
  await updateSupportConversationState(conversation.id, {
    paymentFailed: true,
    paymentFailedAt: new Date(),
    needsAttention: true,
    needsAttentionReason: "The customer's payment failed and they've been notified — needs a person to help them complete payment.",
  });

  const dnd = await isCustomerSmsDnd(personId);
  if (customer?.phone && !dnd) {
    const text = isFirstOrder ? renderPaymentFailedFirstOrderMessage(customer.firstName) : renderPaymentFailedRecurringMessage(customer.firstName);
    try {
      const result = await getSmsProvider().sendMessage(customer.phone, text);
      await appendSupportMessage(conversation.id, "outbound", text, { providerMessageId: result.providerMessageId });
    } catch (err) {
      logger.warn({ personId, reason: err instanceof Error ? err.message : String(err) }, "payment-failed notice send failed");
      await appendSupportMessage(conversation.id, "outbound", text, {});
    }
  } else {
    logger.warn({ personId, reason: dnd ? "do_not_disturb" : "no_phone_number" }, "payment-failed notice not sent");
  }

  if (customer) {
    const emailConversation = await getOrCreateSupportEmailConversation(personId);
    await sendTriggerEmail({
      persona: "sophie",
      personId,
      conversationId: emailConversation.id,
      email: customer.email,
      render: (unsubscribeUrl) => (isFirstOrder ? renderPaymentFailedFirstOrderEmail(customer.firstName, unsubscribeUrl) : renderPaymentFailedRecurringEmail(customer.firstName, unsubscribeUrl)),
      appendMessage: appendSupportEmailMessage,
      logLabel: "payment-failed",
    });
  }
}

/**
 * Internal-only, unlike handlePaymentFailed above — no automated SMS/email
 * to the customer. A refund is usually already communicated to the customer
 * by Bask or by whoever processed it; this just makes sure a person sees it
 * and decides what (if anything) needs to happen next (pausing their
 * account/access, following up on why). Flagging the support conversation
 * already fires the standard needs-attention Slack alert (see
 * updateSupportConversationState), so nothing else needs wiring here.
 */
export async function handleRefund(personId: string, transactionId: string, amount: string | undefined): Promise<void> {
  const conversation = await getOrCreateSupportConversation(personId);
  const amountText = amount ? `$${amount}` : "an unknown amount";
  await updateSupportConversationState(conversation.id, {
    needsAttention: true,
    needsAttentionReason: `A payment was refunded (${amountText}, transaction ${transactionId}) — needs a person to review why and whether anything else should happen (e.g. pausing their account).`,
  });
}

export interface ReviewRequestSweepResult {
  readonly sentCount: number;
  readonly failedCount: number;
  readonly cancelledCount: number;
}

/**
 * Sends every due `pending` review-request trigger, plus any `failed`
 * trigger that hasn't exhausted its retry attempts and has cooled down
 * since its last attempt. Fully automated, no manual step.
 *
 * Safe to call repeatedly, including from overlapping sweep runs — see the
 * identical comment on sweepFollowUpJobs: the claim step atomically flips
 * each due row to `processing` in a single UPDATE before any SMS work
 * happens, so two sweeps racing on the same due trigger can't both send it.
 */
export async function sweepReviewRequestTriggers(): Promise<ReviewRequestSweepResult> {
  const retryEligibleBefore = new Date(Date.now() - RETRY_COOLDOWN_MS);
  const claimed = await db
    .update(reviewRequestTriggersTable)
    .set({ status: "processing" })
    .where(
      or(
        and(eq(reviewRequestTriggersTable.status, "pending"), lte(reviewRequestTriggersTable.dueAt, sql`now()`)),
        and(
          eq(reviewRequestTriggersTable.status, "failed"),
          lt(reviewRequestTriggersTable.attemptCount, MAX_SEND_ATTEMPTS),
          lte(reviewRequestTriggersTable.updatedAt, retryEligibleBefore),
        ),
      ),
    )
    .returning({ id: reviewRequestTriggersTable.id, personId: reviewRequestTriggersTable.personId, attemptCount: reviewRequestTriggersTable.attemptCount });

  let sentCount = 0;
  let failedCount = 0;
  let cancelledCount = 0;

  for (const trigger of claimed) {
    if (await isCustomerSmsDnd(trigger.personId)) {
      await db
        .update(reviewRequestTriggersTable)
        .set({ status: "cancelled", cancelledReason: "opted_out" })
        .where(eq(reviewRequestTriggersTable.id, trigger.id));
      cancelledCount++;
      continue;
    }

    const customer = await getCustomerContact(trigger.personId);
    const conversation = await getOrCreateSupportConversation(trigger.personId);
    const nextAttemptCount = trigger.attemptCount + 1;

    if (!customer?.phone) {
      await db
        .update(reviewRequestTriggersTable)
        .set({ status: "failed", failureReason: "NO_PHONE_NUMBER", attemptCount: nextAttemptCount })
        .where(eq(reviewRequestTriggersTable.id, trigger.id));
      failedCount++;
      continue;
    }

    const text = renderReviewRequestMessage(customer.firstName);

    // The "sent" write below must happen right after a successful send,
    // before anything else that could throw — otherwise a failure in a
    // downstream step (logging into the conversation, flipping
    // reviewRequested) falls into the catch, marks this "failed", and a
    // later sweep retries it: a real duplicate text to the patient, even
    // though the first one already went out.
    let result: { providerMessageId: string };
    try {
      result = await getSmsProvider().sendMessage(customer.phone, text);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await appendSupportMessage(conversation.id, "outbound", text, {});
      await db
        .update(reviewRequestTriggersTable)
        .set({ status: "failed", failureReason: reason, attemptCount: nextAttemptCount })
        .where(eq(reviewRequestTriggersTable.id, trigger.id));
      failedCount++;
      continue;
    }

    await db
      .update(reviewRequestTriggersTable)
      .set({ status: "sent", sentAt: sql`now()`, providerMessageId: result.providerMessageId, attemptCount: nextAttemptCount })
      .where(eq(reviewRequestTriggersTable.id, trigger.id));
    sentCount++;
    // No email leg here — no real template exists yet for the review-
    // request email (see templates.ts), so this stays SMS-only for now.

    try {
      await appendSupportMessage(conversation.id, "outbound", text, { providerMessageId: result.providerMessageId });
      // Only flip reviewRequested once the text is actually confirmed sent —
      // setting it on a failed attempt (as this used to) made Sophie's
      // conversation loop treat the patient's next reply as a sentiment
      // answer to a review check-in question they were never actually sent.
      await updateSupportConversationState(conversation.id, { reviewRequested: true });
    } catch (err) {
      logger.warn({ personId: trigger.personId, reason: err instanceof Error ? err.message : String(err) }, "failed to log review-request send into the conversation");
    }
  }

  if (sentCount > 0 || failedCount > 0 || cancelledCount > 0) {
    logger.info({ sentCount, failedCount, cancelledCount }, "review-request sweep completed");
  }

  return { sentCount, failedCount, cancelledCount };
}
