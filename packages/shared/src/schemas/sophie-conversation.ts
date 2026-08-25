import { z } from "zod";

export const sendSophieTestMessageRequestSchema = z.object({
  customerId: z.string().uuid(),
  message: z.string().min(1).max(2000),
});
export type SendSophieTestMessageRequest = z.infer<typeof sendSophieTestMessageRequestSchema>;

export const sophieTurnResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    action: z.string(),
    reply: z.string().nullable(),
    nextQuestion: z.string().nullable(),
    inboundSentiment: z.enum(["positive", "neutral", "negative"]).nullable(),
    requiresStaff: z.boolean(),
    knowledgeTopicsUsed: z.array(z.string()),
  }),
  z.object({ ok: z.literal(false), code: z.string() }),
]);
export type SophieTurnResponse = z.infer<typeof sophieTurnResponseSchema>;
