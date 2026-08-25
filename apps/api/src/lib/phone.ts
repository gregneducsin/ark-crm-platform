/**
 * Normalizes a phone number to E.164 for a US/Canada (+1) number when it
 * can be recognized as one — the only country code any real customer,
 * lead, or SMS provider payload in this app has ever used. Anything that
 * doesn't resolve to a clean 10-digit (or 11-digit with a leading 1)
 * number is returned trimmed but otherwise unchanged, rather than thrown
 * on — this runs on user- and webhook-supplied input, and a malformed
 * phone number shouldn't block creating/updating the record it's attached
 * to.
 *
 * Without this, the same real number stored two different ways (bare 10
 * digits from one intake path, "+1..." from another) silently fails every
 * exact-match lookup that depends on it — see findCustomerIdByPhone in
 * iblusend-webhook.service.ts, which is exactly how a real inbound text
 * from an existing customer went unanswered.
 */
export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return input.trim();
}

/** Last 10 digits of a phone number, for matching stored values regardless of how they were formatted at write time (with/without +1, dashes, spaces, parens). */
export function phoneMatchKey(input: string): string {
  return input.replace(/\D/g, "").slice(-10);
}
