import { and, eq, inArray } from "drizzle-orm";
import { db, abandonedCartTriggersTable, customersTable } from "@luma/db";
import { sweepScheduledSalesSms, type ScheduledSalesSmsSweepResult } from "./scheduled-sales-sms.service.js";

const OPENER_DELAY_MS = 10 * 60 * 1000;

/**
 * Arms the very first outbound message for a lead, 10 minutes after Bask
 * fires an `abandoned` questionnaire event — fully automated, 24/7, no
 * monitored-hours window. Idempotent: the unique index on
 * questionnaireEventId means a duplicate `abandoned` webhook delivery for
 * the *same* questionnaire event can't schedule (or send) a second opener.
 *
 * That alone doesn't cover a second, distinct questionnaire event for the
 * same person (e.g. a restarted/resubmitted questionnaire gets a new Bask
 * questionnaireId) — same gap as scheduleAbandonedCartEmailSequence, fixed
 * the same way: skip arming a second opener while one is already pending
 * for this person.
 */
export async function scheduleAbandonedCartOpener(personId: string, questionnaireEventId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: customersTable.id }).from(customersTable).where(eq(customersTable.id, personId)).for("update");

    const [existing] = await tx
      .select({ id: abandonedCartTriggersTable.id })
      .from(abandonedCartTriggersTable)
      .where(and(eq(abandonedCartTriggersTable.personId, personId), inArray(abandonedCartTriggersTable.status, ["pending", "processing"])))
      .limit(1);
    if (existing) return;

    await tx
      .insert(abandonedCartTriggersTable)
      .values({ personId, questionnaireEventId, dueAt: new Date(Date.now() + OPENER_DELAY_MS) })
      .onConflictDoNothing({ target: abandonedCartTriggersTable.questionnaireEventId });
  });
}

export type AbandonedCartSweepResult = ScheduledSalesSmsSweepResult;

/** Recheck eligibility under the shared person lock and await provider receipts. */
export async function sweepAbandonedCartTriggers(): Promise<AbandonedCartSweepResult> {
  return sweepScheduledSalesSms("abandoned_cart");
}
