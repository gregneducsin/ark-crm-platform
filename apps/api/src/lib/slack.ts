import { logger } from "./logger.js";

/**
 * Fire-and-forget alert to a Slack Incoming Webhook / Workflow Builder
 * webhook URL. Never throws — callers use this from inside failure paths
 * (a send that already failed, a webhook that already errored), so a Slack
 * outage or missing SLACK_WEBHOOK_URL must never compound that into a
 * second failure. No-ops silently when unconfigured, same fail-soft shape
 * as every other outbound side-channel in this codebase (see
 * sendTriggerEmail's own reasoning).
 */
export async function notifySlack(message: string): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "Slack notification failed");
    }
  } catch (err) {
    logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "Slack notification failed");
  }
}
