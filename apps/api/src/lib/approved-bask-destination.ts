// Exact origins only: no wildcard subdomains or hosts supplied by a webhook.
// BASK_* URL settings are administrator-controlled and support custom Bask domains.
const BRAND_ORIGINS = ["https://patient.tryark.com"];

function parseHttps(value: unknown): { url: URL; value: string } | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    return { url, value: trimmed };
  } catch { return null; }
}

/** Validate at ingestion, minting AND redirect time, including legacy rows.
 * Return no URL on failure, and never include the credential-bearing value in errors.
 */
export function approvedBaskDestination(value: unknown): string | null {
  const candidate = parseHttps(value);
  if (!candidate) return null;
  const origins = new Set(BRAND_ORIGINS);
  for (const configured of [process.env.BASK_QUESTIONNAIRE_URL, process.env.BASK_QUESTIONNAIRE_PROMO_URL]) {
    const parsed = parseHttps(configured);
    if (parsed) origins.add(parsed.url.origin);
  }
  return origins.has(candidate.url.origin) ? candidate.value : null;
}
