import { sweepScheduledSalesSms, type ScheduledSalesSmsSweepResult } from "./scheduled-sales-sms.service.js";

export type FollowUpSweepResult = ScheduledSalesSmsSweepResult;

/** Follow-up steps are armed from the confirmed send time, with current eligibility. */
export async function sweepFollowUpJobs(): Promise<FollowUpSweepResult> {
  return sweepScheduledSalesSms("follow_up");
}
