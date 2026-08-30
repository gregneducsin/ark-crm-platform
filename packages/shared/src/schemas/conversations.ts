import { z } from "zod";

export const conversationSummarySchema = z.object({
  id: z.string(),
  personId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  leadSource: z.enum(["abandoned_cart", "meta_form"]),
  status: z.enum(["active", "closed"]),
  lastMessageAt: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
  lastSentiment: z.enum(["positive", "neutral", "negative"]).nullable(),
  needsAttention: z.boolean(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationResponseStatsSchema = z.object({
  totalContacted: z.number(),
  totalResponded: z.number(),
  responseRate: z.number(),
});
export type ConversationResponseStats = z.infer<typeof conversationResponseStatsSchema>;

export const conversationMessageSchema = z.object({
  id: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  /** Only present for email-channel messages — absent (not merely null) on every SMS message, since the SMS table has no subject column at all. */
  subject: z.string().optional(),
  body: z.string(),
  sentiment: z.enum(["positive", "neutral", "negative"]).nullable(),
  /** Who wrote an outbound message — "ai" (Alexis, or an automated trigger) vs "staff" (typed into the reply box). Null on inbound messages. */
  sentBy: z.enum(["ai", "staff"]).nullable(),
  /** Which staff member sent it, when sentBy is "staff". Null otherwise. */
  sentByStaffEmail: z.string().nullable(),
  createdAt: z.string(),
});
export type ConversationMessageDto = z.infer<typeof conversationMessageSchema>;

export const conversationDetailSchema = z.object({
  conversation: z.object({
    id: z.string(),
    personId: z.string(),
    leadSource: z.enum(["abandoned_cart", "meta_form"]),
    status: z.enum(["active", "closed"]),
    selectedProduct: z.string().nullable(),
    state: z.string().nullable(),
    objectionStage: z.number(),
    linkProvided: z.boolean(),
    promoOffered: z.boolean(),
    needsAttention: z.boolean(),
    needsAttentionReason: z.string().nullable(),
  }),
  /** email is only populated on the email-channel response — optional so the SMS response shape (no email field at all) still matches. */
  customer: z.object({ firstName: z.string(), lastName: z.string(), phone: z.string().nullable(), email: z.string().optional(), hasQualifyingPurchase: z.boolean() }),
  messages: z.array(conversationMessageSchema),
});
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

export const sendConversationReplyRequestSchema = z.object({
  body: z.string().min(1).max(2000),
});
export type SendConversationReplyRequest = z.infer<typeof sendConversationReplyRequestSchema>;

export const sendConversationReplyResponseSchema = z.object({
  sent: z.boolean(),
  reason: z.enum(["not_found", "no_phone", "send_failed"]).optional(),
});
export type SendConversationReplyResponse = z.infer<typeof sendConversationReplyResponseSchema>;
