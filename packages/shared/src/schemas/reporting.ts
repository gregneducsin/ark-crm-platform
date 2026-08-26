import { z } from "zod";

export const funnelSummarySchema = z.object({
  totalLeads: z.number(),
  questionnaireStarted: z.number(),
  questionnaireSubmitted: z.number(),
  purchased: z.number(),
  /** Sum of completed purchases' amountPaid within the query's date range (or all-time, if none given). */
  revenue: z.number(),
});
export type FunnelSummary = z.infer<typeof funnelSummarySchema>;

/**
 * Plain YYYY-MM-DD calendar dates, matching the day-granularity every date
 * filter in this codebase already uses (customers.leadReceivedDate,
 * purchases.purchaseDate) — not a timestamp range. Both must be present
 * together to apply a filter; omit both for all-time.
 */
export const dateRangeQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type DateRangeQuery = z.infer<typeof dateRangeQuerySchema>;

export const messageChannelSchema = z.enum(["sms", "email"]);
export type MessageChannel = z.infer<typeof messageChannelSchema>;

export const messageVolumeRowSchema = z.object({
  channel: messageChannelSchema,
  inbound: z.number(),
  outbound: z.number(),
});
export type MessageVolumeRow = z.infer<typeof messageVolumeRowSchema>;

export const responseTimeStatsSchema = z.object({
  channel: messageChannelSchema,
  avgResponseSeconds: z.number().nullable(),
  responseCount: z.number(),
});
export type ResponseTimeStats = z.infer<typeof responseTimeStatsSchema>;

export const messageReportingResponseSchema = z.object({
  volume: z.array(messageVolumeRowSchema),
  responseTimes: z.array(responseTimeStatsSchema),
});
export type MessageReportingResponse = z.infer<typeof messageReportingResponseSchema>;
