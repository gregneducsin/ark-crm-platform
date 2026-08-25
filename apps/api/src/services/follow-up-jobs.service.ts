import { and, eq, lte, sql } from "drizzle-orm";
import { db, followUpJobsTable, intakeLinkTokensTable, questionnaireEventsTable, purchasesTable, customersTable } from "@luma/db";
import { getSmsProvider } from "../lib/sms-provider.js";
import { renderFollowUpMessage } from "../lib/messaging/follow-up-templates.js";
import { getOrCreateConversation, appendMessage } from "./conversations.service.js";
import { isCustomerSmsDnd } from "./dnd.service.js";
import { logger } from "../lib/logger.js";

const SECOND_STEP_DELAY_MS = 60 * 60 * 1000;

export interface FollowUpSweepResult {
  readonly sentCount: number;
  readonly cancelledCount: number;
  readonly failedCount: number;
}

/**
 * Find every `pending` follow-up job whose due time has passed, and resolve
 * each one — fully automated, no manual step:
 *   - if the person already submitted the questionnaire or completed a
 *     purchase since they clicked the link, cancel the job.
 *   - otherwise, send the message via the SMS provider. On success, mark
 *     `sent` and — if this was the provider_check_in step — schedule
 *     intake_questions_check_in due 1 hour from now (relative to the actual
 *     send, not the original click, so the "an hour later" promise holds
 *     even when the sweep runs a little late).
 *   - if the send itself fails (e.g. no SMS provider configured yet, or a
 *     missing phone number), mark `failed` with a reason. Not retried
 *     automatically — this is expected and correct until a provider exists.
 *
 * Safe to call repeatedly, including from overlapping sweep runs: the claim
 * step atomically flips each due row from `pending` to `processing` in a
 * single UPDATE before any SMS work happens, so two sweeps racing on the
 * same due job can't both see it as `pending` and both send it — the second
 * sweep's UPDATE simply matches zero rows for a job the first already
 * claimed. Jobs are moved to a terminal state for this attempt afterward, so
 * a job is never double-sent.
 */
export async function sweepFollowUpJobs(): Promise<FollowUpSweepResult> {
  const claimed = await db
    .update(followUpJobsTable)
    .set({ status: "processing" })
    .where(and(eq(followUpJobsTable.status, "pending"), lte(followUpJobsTable.dueAt, sql`now()`)))
    .returning({ jobId: followUpJobsTable.id, personId: followUpJobsTable.personId, intakeLinkTokenId: followUpJobsTable.intakeLinkTokenId, messageStep: followUpJobsTable.messageStep });

  let sentCount = 0;
  let cancelledCount = 0;
  let failedCount = 0;

  for (const job of claimed) {
    const [token] = await db
      .select({ clickedAt: intakeLinkTokensTable.clickedAt, leadSource: intakeLinkTokensTable.leadSource })
      .from(intakeLinkTokensTable)
      .where(eq(intakeLinkTokensTable.id, job.intakeLinkTokenId));
    const completed = await hasCompletedSinceClick(job.personId, token?.clickedAt ?? null);

    if (completed) {
      await db
        .update(followUpJobsTable)
        .set({ status: "cancelled", cancelledReason: "completed_before_followup" })
        .where(eq(followUpJobsTable.id, job.jobId));
      cancelledCount++;
      continue;
    }

    // Every SMS send path must check this — see dnd.service.ts. Checked
    // right before sending (not just at job-creation time) since a person
    // can text STOP any time between clicking the link and this sweep
    // running.
    if (await isCustomerSmsDnd(job.personId)) {
      await db
        .update(followUpJobsTable)
        .set({ status: "cancelled", cancelledReason: "opted_out" })
        .where(eq(followUpJobsTable.id, job.jobId));
      cancelledCount++;
      continue;
    }

    const sendResult = await attemptSend(job.personId, job.messageStep);

    if (!sendResult.ok) {
      await db.update(followUpJobsTable).set({ status: "failed", failureReason: sendResult.reason }).where(eq(followUpJobsTable.id, job.jobId));
      failedCount++;
      continue;
    }

    await db
      .update(followUpJobsTable)
      .set({ status: "sent", sentAt: sql`now()`, providerMessageId: sendResult.providerMessageId })
      .where(eq(followUpJobsTable.id, job.jobId));
    sentCount++;

    // Same logging convention every other proactive SMS send already
    // follows (the abandoned-cart opener, the 6-day check-in) — without
    // this, a follow-up nudge is a real text the customer receives that
    // never shows up in their conversation history, leaving the dashboard's
    // last-message stuck on whatever Alexis sent before the follow-up chain
    // took over.
    //
    // This can be the very first SMS conversation row for this person (a
    // follow-up nudge doesn't require any prior inbound text), so the
    // leadSource passed here matters and can't just fall back to
    // getOrCreateConversation's default: that default is "abandoned_cart",
    // which is wrong for a Meta lead whose click came from the emailed
    // version of their nudge — see leadSource on intakeLinkTokensTable.
    try {
      const conversation = await getOrCreateConversation(job.personId, token?.leadSource ?? "abandoned_cart");
      await appendMessage(conversation.id, "outbound", sendResult.body, { providerMessageId: sendResult.providerMessageId });
    } catch (err) {
      logger.warn({ personId: job.personId, reason: err instanceof Error ? err.message : String(err) }, "failed to log follow-up SMS into the conversation");
    }

    if (job.messageStep === "provider_check_in") {
      await db.insert(followUpJobsTable).values({
        personId: job.personId,
        intakeLinkTokenId: job.intakeLinkTokenId,
        messageStep: "intake_questions_check_in",
        dueAt: new Date(Date.now() + SECOND_STEP_DELAY_MS),
      });
    }
  }

  if (sentCount > 0 || cancelledCount > 0 || failedCount > 0) {
    logger.info({ sentCount, cancelledCount, failedCount }, "follow-up job sweep completed");
  }

  return { sentCount, cancelledCount, failedCount };
}

type SendResult = { ok: true; providerMessageId: string; body: string } | { ok: false; reason: string };

async function attemptSend(personId: string, messageStep: "provider_check_in" | "intake_questions_check_in"): Promise<SendResult> {
  const [customer] = await db
    .select({ firstName: customersTable.firstName, phone: customersTable.phone })
    .from(customersTable)
    .where(eq(customersTable.id, personId));

  if (!customer?.phone) {
    return { ok: false, reason: "NO_PHONE_NUMBER" };
  }

  const body = renderFollowUpMessage(messageStep, customer.firstName);

  try {
    const provider = getSmsProvider();
    const result = await provider.sendMessage(customer.phone, body);
    return { ok: true, providerMessageId: result.providerMessageId, body };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ personId, messageStep, reason }, "follow-up SMS send failed");
    return { ok: false, reason };
  }
}

async function hasCompletedSinceClick(personId: string, clickedAt: Date | null): Promise<boolean> {
  if (!clickedAt) return false;

  const [submitted] = await db
    .select({ id: questionnaireEventsTable.id })
    .from(questionnaireEventsTable)
    .where(and(eq(questionnaireEventsTable.personId, personId), eq(questionnaireEventsTable.status, "submitted"), sql`${questionnaireEventsTable.lastEventAt} >= ${clickedAt}`))
    .limit(1);
  if (submitted) return true;

  // purchaseDate is a customer-facing date with no time-of-day component, so
  // comparing it against clickedAt (cast to a date) would treat a purchase
  // made earlier the same calendar day — before the click — as "completed
  // since click." createdAt is the row's real insert timestamp, giving this
  // the same full-precision comparison the questionnaire check above uses.
  const [purchased] = await db
    .select({ id: purchasesTable.id })
    .from(purchasesTable)
    .where(and(eq(purchasesTable.customerId, personId), eq(purchasesTable.status, "completed"), sql`${purchasesTable.createdAt} >= ${clickedAt}`))
    .limit(1);
  return Boolean(purchased);
}
