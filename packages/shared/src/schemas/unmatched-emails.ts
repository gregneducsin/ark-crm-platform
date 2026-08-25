import { z } from "zod";

export const unmatchedEmailThreadSummarySchema = z.object({
  id: z.string(),
  fromAddress: z.string(),
  fromName: z.string().nullable(),
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
export type UnmatchedEmailThreadSummary = z.infer<typeof unmatchedEmailThreadSummarySchema>;

export const unmatchedEmailsListResponseSchema = z.object({
  items: z.array(unmatchedEmailThreadSummarySchema),
});
export type UnmatchedEmailsListResponse = z.infer<typeof unmatchedEmailsListResponseSchema>;

export const unmatchedEmailMessageSchema = z.object({
  id: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  subject: z.string(),
  body: z.string(),
  createdAt: z.string(),
});
export type UnmatchedEmailMessageDto = z.infer<typeof unmatchedEmailMessageSchema>;

export const unmatchedEmailThreadDetailSchema = z.object({
  id: z.string(),
  fromAddress: z.string(),
  fromName: z.string().nullable(),
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
  messages: z.array(unmatchedEmailMessageSchema),
});
export type UnmatchedEmailThreadDetail = z.infer<typeof unmatchedEmailThreadDetailSchema>;

export const sendUnmatchedEmailReplyRequestSchema = z.object({
  body: z.string().min(1).max(2000),
});
export type SendUnmatchedEmailReplyRequest = z.infer<typeof sendUnmatchedEmailReplyRequestSchema>;

export const sendUnmatchedEmailReplyResponseSchema = z.object({
  sent: z.boolean(),
  reason: z.enum(["not_found", "send_failed"]).optional(),
});
export type SendUnmatchedEmailReplyResponse = z.infer<typeof sendUnmatchedEmailReplyResponseSchema>;
