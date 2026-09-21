import { and, eq, lt, lte, or, sql } from "drizzle-orm";
import { db, customersTable, purchasesTable, leadCheckinTriggersTable } from "@luma/db";
import { getOrCreateConversation, appendMessage } from "./conversations.service.js";
import { getSmsProvider } from "../lib/sms-provider.js";
import { isSalesSmsPaused } from "../lib/sales-sms.js";
import { renderCurrentlyTakingCheckin, renderReengagementCheckin } from "../lib/messaging/follow-up-templates.js";
import { logger } from "../lib/logger.js";
import { isCustomerSmsDnd } from "./dnd.service.js";
import { withPersonLock } from "../lib/db-lock.js";

const CHECKIN_DELAY_MS = 6 * 24 * 60 * 60 * 1000;

/**
 * A failed send gets a few retries rather than being lost permanently —
 * same reasoning and mechanism as sweepReviewRequestTriggers.
 */
const MAX_SEND_ATTEMPTS = 3;
const RETRY_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Arms the one-time 6-day check-in for a lead. Called from sendOpener
 * (abandoned-cart.service.ts) and sendMetaLeadOpener (meta-lead.service.ts)
 * right after each sends the very first outbound message to that person —
 * whichever of those two paths fires first for a given lead is what starts
 * the clock. onConflictDoNothing on personId means it's safe to call this
 * unconditionally from both places: only the first call for a person ever
 * actually arms anything.
 */
export async function scheduleLeadCheckin(personId: string): Promise<void> {
  await db
    .insert(leadCheckinTriggersTable)
    .values({ personId, dueAt: new Date(Date.now() + CHECKIN_DELAY_MS) })
    .onConflictDoNothing({ target: leadCheckinTriggersTable.personId });
}

export interface LeadCheckinSweepResult {
  readonly sentCount: number;
  readonly cancelledCount: number;
  readonly failedCount: number;
}

type LeadCheckinVariant = "currently_taking" | "reengagement";

type LeadCheckinSendResult =
  | { kind: "no_phone" }
  | { kind: "failed"; reason: string; variant: LeadCheckinVariant }
  | { kind: "sent"; providerMessageId: string | null; variant: LeadCheckinVariant };

/**
 * Sends every due check-in, plus any failed one that hasn't exhausted its
 * retry attempts and has cooled down since its last attempt. Skips (cancels)
 * a lead who already purchased by the time this fires — the check-in
 * question doesn't make sense for a customer anymore.
 *
 * Safe to call repeatedly, including from overlapping sweep runs — see the
 * identical comment on sweepFollowUpJobs: the claim step atomically flips
 * each due row to `processing` in a single UPDATE before any SMS work
 * happens, so two sweeps racing on the same due trigger can't both send it.
 *
 * While sales SMS is paused, this returns immediately without claiming
 * anything — every due (or retry-eligible) trigger stays untouched so the
 * next sweep after sales resumes picks it up normally, instead of it burning
 * through its retry budget and being marked failed for good.
 */
export async function sweepLeadCheckinTriggers(): Promise<LeadCheckinSweepResult> {
  if (isSalesSmsPaused()) return { sentCount: 0, cancelledCount: 0, failedCount: 0 };

  const retryEligibleBefore = new Date(Date.now() - RETRY_COOLDOWN_MS);
  const claimed = await db
    .update(leadCheckinTriggersTable)
    .set({ status: "processing" })
    .where(
      or(
        and(eq(leadCheckinTriggersTable.status, "pending"), lte(leadCheckinTriggersTable.dueAt, sql`now()`)),
        and(
          eq(leadCheckinTriggersTable.status, "failed"),
          lt(leadCheckinTriggersTable.attemptCount, MAX_SEND_ATTEMPTS),
          lte(leadCheckinTriggersTable.updatedAt, retryEligibleBefore),
        ),
      ),
    )
    .returning({ id: leadCheckinTriggersTable.id, personId: leadCheckinTriggersTable.personId, attemptCount: leadCheckinTriggersTable.attemptCount });

  let sentCount = 0;
  let cancelledCount = 0;
  let failedCount = 0;

  for (const trigger of claimed) {
    const [purchased] = await db.select({ id: purchasesTable.id }).from(purchasesTable).where(and(eq(purchasesTable.customerId, trigger.personId), eq(purchasesTable.status, "completed"))).limit(1);
    if (purchased) {
      await db.update(leadCheckinTriggersTable).set({ status: "cancelled", cancelledReason: "already_purchased" }).where(eq(leadCheckinTriggersTable.id, trigger.id));
      cancelledCount++;
      continue;
    }

    if (await isCustomerSmsDnd(trigger.personId)) {
      await db.update(leadCheckinTriggersTable).set({ status: "cancelled", cancelledReason: "opted_out" }).where(eq(leadCheckinTriggersTable.id, trigger.id));
      cancelledCount++;
      continue;
    }

    const nextAttemptCount = trigger.attemptCount + 1;

    // No email leg here — no real template exists yet for the lead-checkin
    // emails (see templates.ts), so this stays SMS-only until one arrives.

    // Locked against the same per-person key processInboundMessage uses
    // (alexis-dispatch.service.ts) — the conversation read (for
    // currentlyTaking) and the eventual send+log must happen atomically with
    // respect to a live inbound turn, or this proactive check-in can act on
    // stale state while the live turn is mid-write, and both end up
    // sending. Reads the customer/conversation inside the lock too, not just
    // the send, since a stale read is exactly what causes the race.
    const sendResult = await withPersonLock(trigger.personId, async (): Promise<LeadCheckinSendResult> => {
      const [customer] = await db
        .select({ firstName: customersTable.firstName, phone: customersTable.phone })
        .from(customersTable)
        .where(eq(customersTable.id, trigger.personId));
      const conversation = await getOrCreateConversation(trigger.personId);

      if (!customer?.phone) {
        return { kind: "no_phone" };
      }

      // Recheck the slot now, not at arm time — the lead may have answered
      // this question in conversation at any point over the last 6 days.
      const variant = conversation.currentlyTaking === null ? "currently_taking" : "reengagement";
      const text = variant === "currently_taking" ? renderCurrentlyTakingCheckin(customer.firstName) : renderReengagementCheckin(customer.firstName);

      // The "sent" outcome below must be returned right after a successful
      // send, before anything else that could throw — otherwise a failure in
      // a downstream step (logging into the conversation) falls into the
      // catch, is treated as failed, and a later sweep retries it: a real
      // duplicate text to the customer, even though the first one already
      // went out.
      let result: { providerMessageId: string | null };
      try {
        result = await getSmsProvider().sendMessage(customer.phone, text);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn({ personId: trigger.personId, reason }, "lead check-in send failed");
        await appendMessage(conversation.id, "outbound", text, { deliveryStatus: "failed" });
        return { kind: "failed", reason, variant };
      }

      try {
        await appendMessage(conversation.id, "outbound", text, { providerMessageId: result.providerMessageId, deliveryStatus: "sent" });
      } catch (err) {
        logger.warn({ personId: trigger.personId, reason: err instanceof Error ? err.message : String(err) }, "failed to log lead check-in into the conversation");
      }
      return { kind: "sent", providerMessageId: result.providerMessageId, variant };
    });

    if (sendResult.kind === "no_phone") {
      await db
        .update(leadCheckinTriggersTable)
        .set({ status: "failed", failureReason: "NO_PHONE_NUMBER", attemptCount: nextAttemptCount })
        .where(eq(leadCheckinTriggersTable.id, trigger.id));
      failedCount++;
      continue;
    }

    if (sendResult.kind === "failed") {
      await db
        .update(leadCheckinTriggersTable)
        .set({ status: "failed", failureReason: sendResult.reason, variant: sendResult.variant, attemptCount: nextAttemptCount })
        .where(eq(leadCheckinTriggersTable.id, trigger.id));
      failedCount++;
      continue;
    }

    await db
      .update(leadCheckinTriggersTable)
      .set({ status: "sent", sentAt: sql`now()`, providerMessageId: sendResult.providerMessageId, variant: sendResult.variant, attemptCount: nextAttemptCount })
      .where(eq(leadCheckinTriggersTable.id, trigger.id));
    sentCount++;
  }

  if (sentCount > 0 || cancelledCount > 0 || failedCount > 0) {
    logger.info({ sentCount, cancelledCount, failedCount }, "lead check-in sweep completed");
  }

  return { sentCount, cancelledCount, failedCount };
}
