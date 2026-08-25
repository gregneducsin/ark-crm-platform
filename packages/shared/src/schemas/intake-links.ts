import { z } from "zod";

export const intakeLinkResponseSchema = z.object({
  url: z.string(),
  expiresAt: z.string(),
});
export type IntakeLinkResponse = z.infer<typeof intakeLinkResponseSchema>;
