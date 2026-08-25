import { and, eq, lt, lte, or, sql } from "drizzle-orm";
import { db, customersTable, purchasesTable, objectionReengagementTriggersTable } from "@luma/db";
import { getOrCreateConversation, appendMessage } from "./conversations.service.js";
import { getSmsProvider } from "../lib/sms-provider.js";
import { renderReengagementCheckin } from "../lib/messaging/follow-up-templates.js";
import { logger } from "../lib/logger.js";
import { isCustomerSmsDnd } from "./dnd.service.js";

const REENGAGEMENT_DELAY_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * A failed send gets a few retries rather than being lost permanently — same
 * mechanism as sweepLeadCheckinTriggers.
 */
const MAX_SEND_ATTEMPTS = 3;
const RETRY_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Arms a one-time, 2-weeks-out re-engagement text for a lead whose "not
 * ready yet" hesitation just reached STAND_DOWN on the think_about_it
 * objection (see alexis-dispatch.service.ts / alexis-email-dispatch.service.ts,
 * and the standDown comment on think_about_it in objection-handling.ts).
 * "No problem, I'll leave it here for whenever you're ready" shouldn't mean
 * the outreach actually stops forever — this is that follow-through.
 *
 * onConflictDoNothing on personId: only the first time this fires for a
 * given lead ever arms anything, same one-lifetime-event convention as
 * scheduleLeadCheckin. If they hit stand-down on this objection more than
 * once in the same or a later conversation, the original 2-week timer
 * (or its outcome) already covers it.
 */
export async function scheduleObjectionReengagement(personId: string, leadSource: "abandoned_cart" | "meta_form" = "abandoned_cart"): Promise<void> {
  await db
    .insert(objectionReengagementTriggersTable)
    .values({ personId, leadSource, dueAt: new Date(Date.now() + REENGAGEMENT_DELAY_MS) })
    .onConflictDoNothing({ target: objectionReengagementTriggersTable.personId });
}

export interface ObjectionReengagementSweepResult {
  readonly sentCount: number;
  readonly cancelledCount: number;
  readonly failedCount: number;
}

/**
 * Sends every due re-engagement text, plus any failed one still within its
 * retry budget. Cancels rather than sends when the lead already purchased or
 * has since opted out — same reasoning and mechanism as
 * sweepLeadCheckinTriggers, including the atomic pending→processing claim
 * that makes this safe to call from overlapping sweep runs.
 */
export async function sweepObjectionReengagementTriggers(): Promise<ObjectionReengagementSweepResult> {
  const retryEligibleBefore = new Date(Date.now() - RETRY_COOLDOWN_MS);
  const claimed = await db
    .update(objectionReengagementTriggersTable)
    .set({ status: "processing" })
    .where(
      or(
        and(eq(objectionReengagementTriggersTable.status, "pending"), lte(objectionReengagementTriggersTable.dueAt, sql`now()`)),
        and(
          eq(objectionReengagementTriggersTable.status, "failed"),
          lt(objectionReengagementTriggersTable.attemptCount, MAX_SEND_ATTEMPTS),
          lte(objectionReengagementTriggersTable.updatedAt, retryEligibleBefore),
        ),
      ),
    )
    .returning({
      id: objectionReengagementTriggersTable.id,
      personId: objectionReengagementTriggersTable.personId,
      leadSource: objectionReengagementTriggersTable.leadSource,
      attemptCount: objectionReengagementTriggersTable.attemptCount,
    });

  let sentCount = 0;
  let cancelledCount = 0;
  let failedCount = 0;

  for (const trigger of claimed) {
    const [purchased] = await db
      .select({ id: purchasesTable.id })
      .from(purchasesTable)
      .where(and(eq(purchasesTable.customerId, trigger.personId), eq(purchasesTable.status, "completed")))
      .limit(1);
    if (purchased) {
      await db.update(objectionReengagementTriggersTable).set({ status: "cancelled", cancelledReason: "already_purchased" }).where(eq(objectionReengagementTriggersTable.id, trigger.id));
      cancelledCount++;
      continue;
    }

    if (await isCustomerSmsDnd(trigger.personId)) {
      await db.update(objectionReengagementTriggersTable).set({ status: "cancelled", cancelledReason: "opted_out" }).where(eq(objectionReengagementTriggersTable.id, trigger.id));
      cancelledCount++;
      continue;
    }

    const [customer] = await db.select({ firstName: customersTable.firstName, phone: customersTable.phone }).from(customersTable).where(eq(customersTable.id, trigger.personId));
    const nextAttemptCount = trigger.attemptCount + 1;

    if (!customer?.phone) {
      await db
        .update(objectionReengagementTriggersTable)
        .set({ status: "failed", failureReason: "NO_PHONE_NUMBER", attemptCount: nextAttemptCount })
        .where(eq(objectionReengagementTriggersTable.id, trigger.id));
      failedCount++;
      continue;
    }

    const conversation = await getOrCreateConversation(trigger.personId, trigger.leadSource);
    const text = renderReengagementCheckin(customer.firstName);

    // The "sent" write below must happen right after a successful send,
    // before anything else that could throw — otherwise a failure in a
    // downstream step (logging into the conversation) falls into the catch,
    // marks this "failed", and a later sweep retries it: a real duplicate
    // text to the customer, even though the first one already went out.
    let result: { providerMessageId: string };
    try {
      result = await getSmsProvider().sendMessage(customer.phone, text);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ personId: trigger.personId, reason }, "objection re-engagement send failed");
      await appendMessage(conversation.id, "outbound", text, {});
      await db
        .update(objectionReengagementTriggersTable)
        .set({ status: "failed", failureReason: reason, attemptCount: nextAttemptCount })
        .where(eq(objectionReengagementTriggersTable.id, trigger.id));
      failedCount++;
      continue;
    }

    await db
      .update(objectionReengagementTriggersTable)
      .set({ status: "sent", sentAt: sql`now()`, providerMessageId: result.providerMessageId, attemptCount: nextAttemptCount })
      .where(eq(objectionReengagementTriggersTable.id, trigger.id));
    sentCount++;

    try {
      await appendMessage(conversation.id, "outbound", text, { providerMessageId: result.providerMessageId });
    } catch (err) {
      logger.warn({ personId: trigger.personId, reason: err instanceof Error ? err.message : String(err) }, "failed to log objection re-engagement into the conversation");
    }
  }

  if (sentCount > 0 || cancelledCount > 0 || failedCount > 0) {
    logger.info({ sentCount, cancelledCount, failedCount }, "objection re-engagement sweep completed");
  }

  return { sentCount, cancelledCount, failedCount };
}
