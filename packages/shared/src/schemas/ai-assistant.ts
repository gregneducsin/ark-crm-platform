import { z } from "zod";

export const aiAssistantMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
});
export type AiAssistantMessage = z.infer<typeof aiAssistantMessageSchema>;

export const askAiAssistantRequestSchema = z.object({
  question: z.string().min(1).max(2000),
  // Prior turns in this conversation, oldest first — sent back each time
  // since the assistant is stateless server-side.
  history: z.array(aiAssistantMessageSchema).max(20).optional(),
});
export type AskAiAssistantRequest = z.infer<typeof askAiAssistantRequestSchema>;

export const askAiAssistantResponseSchema = z.object({
  answer: z.string(),
});
export type AskAiAssistantResponse = z.infer<typeof askAiAssistantResponseSchema>;
