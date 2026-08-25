import { z } from "zod";

export const upcomingTriggerSchema = z.object({
  kind: z.enum([
    "follow_up",
    "abandoned_cart_sms",
    "lead_checkin_sms",
    "objection_reengagement_sms",
    "abandoned_cart_email",
    "meta_lead_email",
    "review_request_sms",
  ]),
  label: z.string(),
  dueAt: z.string(),
  status: z.enum(["pending", "processing"]),
});
export type UpcomingTrigger = z.infer<typeof upcomingTriggerSchema>;

export const upcomingTriggerResponseSchema = z.object({
  trigger: upcomingTriggerSchema.nullable(),
});
export type UpcomingTriggerResponse = z.infer<typeof upcomingTriggerResponseSchema>;

export const cancelUpcomingTriggerRequestSchema = z.object({
  kind: upcomingTriggerSchema.shape.kind,
});
export type CancelUpcomingTriggerRequest = z.infer<typeof cancelUpcomingTriggerRequestSchema>;

export const cancelUpcomingTriggerResponseSchema = z.object({
  // false when the trigger already resolved (sent/cancelled elsewhere)
  // between the banner loading and staff clicking Cancel.
  cancelled: z.boolean(),
});
export type CancelUpcomingTriggerResponse = z.infer<typeof cancelUpcomingTriggerResponseSchema>;
