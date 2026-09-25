import { db, leadCheckinTriggersTable } from "@luma/db";
import { sweepScheduledSalesSms, type ScheduledSalesSmsSweepResult } from "./scheduled-sales-sms.service.js";

const CHECKIN_DELAY_MS = 6 * 24 * 60 * 60 * 1000;

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

export type LeadCheckinSweepResult = ScheduledSalesSmsSweepResult;

/** Recheck eligibility under the shared person lock and await provider receipts. */
export async function sweepLeadCheckinTriggers(): Promise<LeadCheckinSweepResult> {
  return sweepScheduledSalesSms("lead_checkin");
}
