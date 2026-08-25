import { z } from "zod";

export const unmatchedSmsThreadSummarySchema = z.object({
  id: z.string(),
  fromPhone: z.string(),
  fromName: z.string().nullable(),
  collectedEmail: z.string().nullable(),
  aiIntent: z.enum(["new_lead_interest", "existing_customer_support", "spam_or_irrelevant", "other"]).nullable(),
  aiSummary: z.string().nullable(),
  suggestedMatchCustomerId: z.string().nullable(),
  suggestedMatchConfidence: z.enum(["high", "medium", "low"]).nullable(),
  suggestedReply: z.string().nullable(),
  linkedCustomerId: z.string().nullable(),
  status: z.enum(["needs_review", "replied", "dismissed"]),
  repliedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastMessageAt: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
});
export type UnmatchedSmsThreadSummary = z.infer<typeof unmatchedSmsThreadSummarySchema>;

export const unmatchedSmsListResponseSchema = z.object({
  items: z.array(unmatchedSmsThreadSummarySchema),
});
export type UnmatchedSmsListResponse = z.infer<typeof unmatchedSmsListResponseSchema>;

export const unmatchedSmsMessageSchema = z.object({
  id: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  body: z.string(),
  createdAt: z.string(),
});
export type UnmatchedSmsMessageDto = z.infer<typeof unmatchedSmsMessageSchema>;

export const unmatchedSmsThreadDetailSchema = z.object({
  id: z.string(),
  fromPhone: z.string(),
  fromName: z.string().nullable(),
  collectedEmail: z.string().nullable(),
  aiIntent: z.enum(["new_lead_interest", "existing_customer_support", "spam_or_irrelevant", "other"]).nullable(),
  aiSummary: z.string().nullable(),
  suggestedMatchCustomerId: z.string().nullable(),
  suggestedMatchConfidence: z.enum(["high", "medium", "low"]).nullable(),
  suggestedReply: z.string().nullable(),
  linkedCustomerId: z.string().nullable(),
  status: z.enum(["needs_review", "replied", "dismissed"]),
  repliedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(unmatchedSmsMessageSchema),
});
export type UnmatchedSmsThreadDetail = z.infer<typeof unmatchedSmsThreadDetailSchema>;

export const sendUnmatchedSmsReplyRequestSchema = z.object({
  body: z.string().min(1).max(1200),
});
export type SendUnmatchedSmsReplyRequest = z.infer<typeof sendUnmatchedSmsReplyRequestSchema>;

export const sendUnmatchedSmsReplyResponseSchema = z.object({
  sent: z.boolean(),
  reason: z.enum(["not_found", "no_phone", "send_failed"]).optional(),
});
export type SendUnmatchedSmsReplyResponse = z.infer<typeof sendUnmatchedSmsReplyResponseSchema>;
