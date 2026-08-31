import { z } from "zod";

/**
 * Read-only view onto webhook_events for the portal's Webhook Log page —
 * built specifically so staff configuring a webhook (Zapier, Bask's own
 * builder) can see what actually arrived and why it was rejected, without
 * needing Railway log access. A "failed" row here can mean either an
 * invalid payload that never passed validation (see
 * respondToInvalidWebhookPayload) or a valid payload whose processing
 * threw (see markWebhookEventFailed) — errorMessage distinguishes them.
 */
export const webhookEventStatusSchema = z.enum(["received", "processed", "failed"]);
export type WebhookEventStatus = z.infer<typeof webhookEventStatusSchema>;

export const webhookEventItemSchema = z.object({
  id: z.string(),
  source: z.string(),
  externalEventId: z.string(),
  personId: z.string().nullable(),
  customerName: z.string().nullable(),
  status: webhookEventStatusSchema,
  errorMessage: z.string().nullable(),
  rawPayload: z.unknown(),
  receivedAt: z.string(),
  processedAt: z.string().nullable(),
});
export type WebhookEventItem = z.infer<typeof webhookEventItemSchema>;

export const webhookEventsListResponseSchema = z.object({
  items: z.array(webhookEventItemSchema),
});
export type WebhookEventsListResponse = z.infer<typeof webhookEventsListResponseSchema>;
