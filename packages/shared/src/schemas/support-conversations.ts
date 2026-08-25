import { z } from "zod";

export const supportConversationSummarySchema = z.object({
  id: z.string(),
  personId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  status: z.enum(["active", "closed"]),
  lastMessageAt: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
  lastSentiment: z.enum(["positive", "neutral", "negative"]).nullable(),
  needsAttention: z.boolean(),
});
export type SupportConversationSummary = z.infer<typeof supportConversationSummarySchema>;

export const supportConversationMessageSchema = z.object({
  id: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  /** Only present for email-channel messages — absent (not merely null) on every SMS message, since the SMS table has no subject column at all. */
  subject: z.string().optional(),
  body: z.string(),
  sentiment: z.enum(["positive", "neutral", "negative"]).nullable(),
  /** Who wrote an outbound message — "ai" (Sophie, or an automated trigger) vs "staff" (typed into the reply box). Null on inbound messages. */
  sentBy: z.enum(["ai", "staff"]).nullable(),
  /** Which staff member sent it, when sentBy is "staff". Null otherwise. */
  sentByStaffEmail: z.string().nullable(),
  createdAt: z.string(),
});
export type SupportConversationMessageDto = z.infer<typeof supportConversationMessageSchema>;

export const supportConversationDetailSchema = z.object({
  conversation: z.object({
    id: z.string(),
    personId: z.string(),
    status: z.enum(["active", "closed"]),
    prescriptionWritten: z.boolean(),
    orderShipped: z.boolean(),
    trackingNumber: z.string().nullable(),
    reviewRequested: z.boolean(),
    reviewSentiment: z.enum(["positive", "neutral", "negative"]).nullable(),
    needsAttention: z.boolean(),
    needsAttentionReason: z.string().nullable(),
  }),
  /** email is only populated on the email-channel response — optional so the SMS response shape (no email field at all) still matches. */
  customer: z.object({ firstName: z.string(), lastName: z.string(), phone: z.string().nullable(), email: z.string().optional() }),
  messages: z.array(supportConversationMessageSchema),
});
export type SupportConversationDetail = z.infer<typeof supportConversationDetailSchema>;

export const sendSupportConversationReplyRequestSchema = z.object({
  body: z.string().min(1).max(2000),
});
export type SendSupportConversationReplyRequest = z.infer<typeof sendSupportConversationReplyRequestSchema>;

export const sendSupportConversationReplyResponseSchema = z.object({
  sent: z.boolean(),
  reason: z.enum(["not_found", "no_phone", "send_failed"]).optional(),
});
export type SendSupportConversationReplyResponse = z.infer<typeof sendSupportConversationReplyResponseSchema>;
