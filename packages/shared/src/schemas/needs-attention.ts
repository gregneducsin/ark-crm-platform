import { z } from "zod";

/**
 * The exact needsAttentionReason text written when a conversation is
 * flagged because the customer's message didn't clearly fit any approved
 * script — i.e. the AI genuinely didn't know how to handle it, as opposed
 * to being flagged on purpose for a specific policy reason (stop request,
 * emergency, medical/legal judgment). Defined once here, not duplicated, so
 * the writer (apps/api's needs-attention-reason.ts) and the reader (the
 * Needs Attention page's "AI didn't understand" filter) can never drift
 * out of sync with each other.
 */
export const AI_DIDNT_UNDERSTAND_REASON =
  "Flagged for a person's judgment — the customer's message didn't clearly fit any of the approved scripts (e.g. they may have asked to speak with a person).";

export const needsAttentionChannelSchema = z.enum(["sms", "email"]);
export type NeedsAttentionChannel = z.infer<typeof needsAttentionChannelSchema>;

export const needsAttentionPersonaSchema = z.enum(["alexis", "sophie"]);
export type NeedsAttentionPersona = z.infer<typeof needsAttentionPersonaSchema>;

export const needsAttentionItemSchema = z.object({
  conversationId: z.string(),
  channel: needsAttentionChannelSchema,
  persona: needsAttentionPersonaSchema,
  personId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  lastMessagePreview: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
  reason: z.string().nullable(),
});
export type NeedsAttentionItem = z.infer<typeof needsAttentionItemSchema>;

export const needsAttentionListResponseSchema = z.object({
  items: z.array(needsAttentionItemSchema),
});
export type NeedsAttentionListResponse = z.infer<typeof needsAttentionListResponseSchema>;

export const needsAttentionMessageSchema = z.object({
  id: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  subject: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
});
export type NeedsAttentionMessage = z.infer<typeof needsAttentionMessageSchema>;

export const needsAttentionMessagesResponseSchema = z.object({
  messages: z.array(needsAttentionMessageSchema),
});
export type NeedsAttentionMessagesResponse = z.infer<typeof needsAttentionMessagesResponseSchema>;
