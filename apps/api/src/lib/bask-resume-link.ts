import { approvedBaskDestination } from "./approved-bask-destination.js";
/**
 * Pulls the patient's "magic" resume link out of a Bask abandoned-session
 * payload, if Bask sent one.
 *
 * Bask's webhook body builder lets whoever configures the endpoint choose
 * the field names, so the exact key isn't fixed. Known likely names are
 * tried first, in priority order; failing that, any key that mentions
 * "magic" or "resume" is accepted. Only an approved absolute HTTPS destination counts —
 * anything else (a bare token, an unexpected object) is ignored rather than
 * stored, so a misconfigured mapping can never put junk in front of staff.
 *
 * The link signs the patient back into their own Bask session, so treat the
 * stored value like a credential: it is only ever shown to signed-in staff.
 */
const PREFERRED_KEYS = [
  // Bask's own data-token name is "Data Magic Link"; depending on how the
  // body is mapped it arrives under one of these spellings.
  "Data Magic Link", "dataMagicLink", "data_magic_link", "DataMagicLink",
  "magicLink", "magic_link", "magicUrl", "magic_url",
  "resumeLink", "resume_link", "resumeUrl", "resume_url",
  "sessionLink", "session_link", "sessionUrl", "session_url",
] as const;

const FALLBACK_KEY = /magic|resume/i;
export function extractBaskResumeLink(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  for (const key of PREFERRED_KEYS) {
    const found = approvedBaskDestination(record[key]);
    if (found) return found;
  }
  for (const [key, value] of Object.entries(record)) {
    if (!FALLBACK_KEY.test(key)) continue;
    const found = approvedBaskDestination(value);
    if (found) return found;
  }
  return null;
}
