import { logger } from "./logger.js";

// Slack's Block Kit caps a section's text object at 3000 characters — a
// Workflow Builder "Send a message to a channel" step silently fails with
// an opaque "Input validation error / invalid_blocks" (no partial send,
// nothing in our own logs, since our POST to the webhook trigger already
// succeeded by the time Slack's workflow engine gets to that step) once the
// message crosses that limit. Two call sites forward a caught error's
// `.message` verbatim (a webhook-processing failure, an SMS/email send
// failure) and those can easily run past 3000 characters — a raw Postgres
// error alone regularly includes multi-line detail/hint/where text. Staying
// well under the real cap leaves room for whatever wrapping Slack's
// workflow step itself adds around the substituted variable.
const SLACK_MESSAGE_MAX_LENGTH = 2800;

function truncateForSlack(message: string): string {
  return message.length > SLACK_MESSAGE_MAX_LENGTH ? `${message.slice(0, SLACK_MESSAGE_MAX_LENGTH)}… (truncated)` : message;
}

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
      body: JSON.stringify({ message: truncateForSlack(message) }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "Slack notification failed");
    }
  } catch (err) {
    logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "Slack notification failed");
  }
}
