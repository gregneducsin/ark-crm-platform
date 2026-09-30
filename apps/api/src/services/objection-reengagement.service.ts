import { db, objectionReengagementTriggersTable } from "@luma/db";
import { sweepScheduledSalesSms, type ScheduledSalesSmsSweepResult } from "./scheduled-sales-sms.service.js";

const REENGAGEMENT_DELAY_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Arms a one-time, 2-weeks-out re-engagement text for a lead who just
 * reached STAND_DOWN on the think_about_it or price objection (see
 * alexis-dispatch.service.ts / alexis-email-dispatch.service.ts, and each
 * objection's standDown comment in objection-handling.ts). "No problem,
 * I'll leave it here for whenever you're ready" / "we're here whenever the
 * timing's better" shouldn't mean the outreach actually stops forever —
 * this is that follow-through.
 *
 * onConflictDoNothing on personId: only the first time this fires for a
 * given lead ever arms anything, same one-lifetime-event convention as
 * scheduleLeadCheckin — shared across BOTH objections, not one timer each,
 * so standing down on price then later think_about_it (or vice versa) in
 * the same lead's journey still only ever gets the one re-engagement text.
 * If they hit stand-down on either objection more than once in the same or
 * a later conversation, the original 2-week timer (or its outcome) already
 * covers it.
 */
export async function scheduleObjectionReengagement(personId: string, leadSource: "abandoned_cart" | "meta_form" = "abandoned_cart"): Promise<void> {
  await db
    .insert(objectionReengagementTriggersTable)
    .values({ personId, leadSource, dueAt: new Date(Date.now() + REENGAGEMENT_DELAY_MS) })
    .onConflictDoNothing({ target: objectionReengagementTriggersTable.personId });
}

export type ObjectionReengagementSweepResult = ScheduledSalesSmsSweepResult;

/** Recheck eligibility under the shared person lock and await provider receipts. */
export async function sweepObjectionReengagementTriggers(): Promise<ObjectionReengagementSweepResult> {
  return sweepScheduledSalesSms("objection_reengagement");
}
