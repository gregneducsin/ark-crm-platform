import { z } from "zod";

/**
 * Consolidates conversations.ts (Alexis/sales) and support-conversations.ts
 * (Sophie/support) into one merged, interleaved-timeline view — the four
 * underlying tables (SMS/email x sales/support) stay exactly as they are,
 * this just reads across all four and presents them as a single thread per
 * customer. "persona" names the pipeline (sales vs support), independent
 * of whatever bot name each brand uses for it.
 */
export const conversationPersonaSchema = z.enum(["sales", "support"]);
export type ConversationPersona = z.infer<typeof conversationPersonaSchema>;

export const conversationChannelSchema = z.enum(["sms", "email"]);
export type UnifiedConversationChannel = z.infer<typeof conversationChannelSchema>;

export const unifiedMessageSchema = z.object({
  id: z.string(),
  persona: conversationPersonaSchema,
  channel: conversationChannelSchema,
  direction: z.enum(["inbound", "outbound"]),
  /** Only present for email-channel messages — absent (not merely null) on every SMS message. */
  subject: z.string().optional(),
  body: z.string(),
  sentiment: z.enum(["positive", "neutral", "negative"]).nullable(),
  sentBy: z.enum(["ai", "staff"]).nullable(),
  sentByStaffEmail: z.string().nullable(),
  createdAt: z.string(),
});
export type UnifiedMessage = z.infer<typeof unifiedMessageSchema>;

export const unifiedConversationSummarySchema = z.object({
  personId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  /** Most recent message across all four of this person's threads, whichever it came from. */
  lastMessageAt: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
  lastSentiment: z.enum(["positive", "neutral", "negative"]).nullable(),
  /** true if ANY of the person's up-to-four threads currently needs attention. */
  needsAttention: z.boolean(),
  leadSource: z.enum(["abandoned_cart", "meta_form"]).nullable(),
  hasSalesThread: z.boolean(),
  hasSupportThread: z.boolean(),
});
export type UnifiedConversationSummary = z.infer<typeof unifiedConversationSummarySchema>;

/** Sales-only response-rate stat, deduplicated per customer across SMS+email — support was never covered by this on the old Conversations tab either. */
export const salesResponseStatsSchema = z.object({
  totalContacted: z.number(),
  totalResponded: z.number(),
  responseRate: z.number(),
});
export type SalesResponseStats = z.infer<typeof salesResponseStatsSchema>;

export const salesThreadInfoSchema = z.object({
  needsAttention: z.boolean(),
  needsAttentionReason: z.string().nullable(),
  leadSource: z.enum(["abandoned_cart", "meta_form"]),
  selectedProduct: z.string().nullable(),
  objectionStage: z.number(),
  promoOffered: z.boolean(),
  linkProvided: z.boolean(),
  /** True once the customer's most recently sent intake link (see linkProvided above) has actually been clicked. */
  intakeLinkClicked: z.boolean(),
});
export type SalesThreadInfo = z.infer<typeof salesThreadInfoSchema>;

export const supportThreadInfoSchema = z.object({
  needsAttention: z.boolean(),
  needsAttentionReason: z.string().nullable(),
  prescriptionWritten: z.boolean(),
  orderShipped: z.boolean(),
  trackingNumber: z.string().nullable(),
  reviewRequested: z.boolean(),
  reviewSentiment: z.enum(["positive", "neutral", "negative"]).nullable(),
});
export type SupportThreadInfo = z.infer<typeof supportThreadInfoSchema>;

export const unifiedConversationDetailSchema = z.object({
  customer: z.object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    hasQualifyingPurchase: z.boolean(),
  }),
  /** null when this person has no sales thread on either channel. */
  sales: salesThreadInfoSchema.nullable(),
  /** null when this person has no support thread on either channel. */
  support: supportThreadInfoSchema.nullable(),
  /** Every message across all of this person's existing threads, chronological. */
  messages: z.array(unifiedMessageSchema),
  /** Which of the four (persona x channel) pipelines actually has a conversation row for this person — the reply composer only offers these, since a reply always targets an existing thread. */
  availableReplyTargets: z.array(z.object({ persona: conversationPersonaSchema, channel: conversationChannelSchema })),
});
export type UnifiedConversationDetail = z.infer<typeof unifiedConversationDetailSchema>;

/** A reply always goes out through exactly one pipeline — persona+channel picks which. */
export const sendUnifiedConversationReplyRequestSchema = z.object({
  persona: conversationPersonaSchema,
  channel: conversationChannelSchema,
  body: z.string().min(1).max(2000),
});
export type SendUnifiedConversationReplyRequest = z.infer<typeof sendUnifiedConversationReplyRequestSchema>;

export const sendUnifiedConversationReplyResponseSchema = z.object({
  sent: z.boolean(),
  reason: z.enum(["not_found", "no_phone", "send_failed"]).optional(),
});
export type SendUnifiedConversationReplyResponse = z.infer<typeof sendUnifiedConversationReplyResponseSchema>;
