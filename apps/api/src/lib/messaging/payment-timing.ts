/** Only a date-only payment constraint can be separated from price acceptance. */
export function paymentTimingParts(text: string): { acceptance: string; timing: string } | null {
  const normalized = text.trim().replace(/[’]/g, "'");
  const match = normalized.match(/^(.*?)(?:[, ]+\b(?:but|and)\b[, ]+|,\s*|^)(?:i\s+)?(?:cannot|can't|can not|will not be able to|won't be able to|am not able to)\s+pay(?:\s+for\s+(?:it|the plan))?\s+(?:until|till)\s+(.+?)[.! ]*$/i);
  if (!match) return null;
  const date = match[2].trim();
  const dateOnly = /^(?:(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?(?:\s+of)?\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+\d{1,2}(?:st|nd|rd|th)?)?(?:,?\s+\d{4})?$|^(?:the\s+)?\d{1,2}(?:st|nd|rd|th)$|^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$|^(?:next|this)\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$|^(?:tomorrow|payday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;
  if (!dateOnly.test(date)) return null;
  return { acceptance: match[1].trim().replace(/,$/, ""), timing: date };
}
