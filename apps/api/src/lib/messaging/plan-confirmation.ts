import type { BotPreviewRequestBody } from "./types.js";

function durations(text: string): string[] {
  const normalized = text.toLowerCase().replace(/\bmonth[ -]to[ -]month\b/g, "1 month");
  return [...normalized.matchAll(/\b(1|one|3|three|6|six)[ -]?months?\b/g)]
    .map((match) => {
      const months = ({ one: "1", three: "3", six: "6" } as Record<string, string>)[match[1]] ?? match[1];
      return months === "1" ? "month_to_month" : `${months}_month`;
    });
}

/** A recommendation, price question or vague agreement is not a plan selection.
 * Fail conservatively: the model can ask an explicit confirmation on retry.
 */
export function hasPlanConfirmation(body: Pick<BotPreviewRequestBody, "messages" | "lastQuestion"> & { currentSlots: Pick<BotPreviewRequestBody["currentSlots"], "planLength"> }, proposed: unknown): boolean {
  if (proposed === undefined || proposed === null || proposed === body.currentSlots.planLength) return true;
  const inbound = ([...body.messages].reverse().find((message) => message.direction === "inbound")?.body.trim() ?? "").replace(/\bmonth[ -]to[ -]month\b/gi, "1 month");
  if (/\?|\b(no|not|don't|dont|unsure|maybe|perhaps|scam|whatever|recommend|thinking|considering)\b/i.test(inbound)) return false;
  const choices = new Set(durations(inbound));
  if (choices.size === 1 && choices.has(String(proposed))) {
    return /\b(i want|i choose|i pick|i prefer|i'll take|ill take|i will take|let's do|lets do|sign me up for|go with)\s+(?:(?:the|your|a)\s+)?(?:1|one|3|three|6|six)[ -]?months?\b/i.test(inbound)
      || /^(?:the\s+)?(?:1|one|3|three|6|six)[ -]?months?(?:\s+plan)?(?:[, ]+please)?[.!]?$/i.test(inbound);
  }
  if (!/^(yes|yes please|yep|yeah|correct|confirmed|sounds good|let's do it|lets do it)[.!]?$/i.test(inbound)) return false;
  const question = (body.lastQuestion ?? "").replace(/\bmonth[ -]to[ -]month\b/gi, "1 month");
  const offered = new Set(durations(question));
  return offered.size === 1 && offered.has(String(proposed))
    && /\b(?:would you like|do you want|shall we|should we|confirm|ready to|want to|go with)\s+(?:to\s+)?(?:(?:start|choose|select|take|go with)\s+)?(?:the\s+)?(?:1|one|3|three|6|six)[ -]?months?\b/i.test(question);
}
