/**
 * Strips em dashes and en dashes from AI-drafted text — the SMS-style
 * prompts for both Alexis and Sophie already instruct the model not to use
 * them ("Use a comma or a new sentence instead"), but a prompt instruction
 * is never a guarantee. This is the code-level backstop applied to every
 * outbound reply/nextQuestion right after the provider response is
 * validated, so a customer never sees a dash the model slipped past the
 * prompt rule.
 */
export function stripEmDashes<T extends string | null>(text: T): T {
  if (text === null) return text;
  return text.replace(/\s*[—–]\s*/g, ", ").replace(/,\s*,/g, ",") as T;
}
