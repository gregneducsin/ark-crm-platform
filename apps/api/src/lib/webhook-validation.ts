import type { Request, Response } from "express";
import type { ZodError } from "zod";
import { randomUUID } from "node:crypto";
import { db, webhookEventsTable, type WebhookEvent } from "@luma/db";
import { logger } from "./logger.js";

function summarizeIssues(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

/**
 * None of our webhook senders (Bask's own webhook builder included) ever
 * show back the response body of a failed delivery — so a 400 in the HTTP
 * response alone is invisible to whoever is configuring the webhook. This
 * both logs it (Railway logs) and records it as a "failed" row in
 * webhook_events, so it shows up in the portal's Webhook Log page too —
 * the only record of a delivery that never made it past validation, since
 * `recordWebhookEventIfNew` (used on the success path) never runs.
 * `externalEventId` is synthesized (a malformed payload may not even have
 * one) — it only needs to be unique, not meaningful, since a row like this
 * is never looked up by it.
 */
export async function respondToInvalidWebhookPayload(source: WebhookEvent["source"], req: Request, res: Response, error: ZodError): Promise<void> {
  const errorMessage = summarizeIssues(error);
  logger.warn({ source, issues: error.issues, payload: req.body }, "webhook payload failed validation");
  await db.insert(webhookEventsTable).values({
    source,
    externalEventId: `invalid-${randomUUID()}`,
    status: "failed",
    rawPayload: req.body,
    errorMessage,
  });
  res.status(400).json({ error: "Invalid payload.", details: error.issues });
}
