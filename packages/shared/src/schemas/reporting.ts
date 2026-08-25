import { z } from "zod";

export const funnelSummarySchema = z.object({
  totalLeads: z.number(),
  questionnaireStarted: z.number(),
  questionnaireSubmitted: z.number(),
  purchased: z.number(),
});
export type FunnelSummary = z.infer<typeof funnelSummarySchema>;

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
