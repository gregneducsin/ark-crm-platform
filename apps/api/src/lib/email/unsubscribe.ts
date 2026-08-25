import crypto from "crypto";

/**
 * Stateless, signed one-click-unsubscribe token (CAN-SPAM requires every
 * commercial/automated email to carry a working opt-out mechanism). No new
 * table: the token is just the personId plus an HMAC-SHA256 signature over
 * it, so any automated email can embed a working unsubscribe link without a
 * mint-and-store step, and the link never expires (a dead unsubscribe link
 * is a compliance problem, an unlimited-lifetime one isn't).
 */

function secret(): string {
  const value = process.env.EMAIL_UNSUBSCRIBE_SECRET;
  if (!value) {
    throw new Error("EMAIL_UNSUBSCRIBE_SECRET is not configured.");
  }
  return value;
}

export function signUnsubscribeToken(personId: string): string {
  const personIdB64 = Buffer.from(personId, "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret()).update(personId).digest("hex");
  return `${personIdB64}.${signature}`;
}

/**
 * Full unsubscribe link for a customer, built off the same API-reachable
 * base URL as the intake trigger links (INTAKE_LINK_BASE_URL — this route
 * and /go live on the same host).
 */
export function buildUnsubscribeUrl(personId: string): string {
  const baseUrl = process.env.INTAKE_LINK_BASE_URL;
  if (!baseUrl) {
    throw new Error("INTAKE_LINK_BASE_URL is not configured.");
  }
  return `${baseUrl}/unsubscribe/${signUnsubscribeToken(personId)}`;
}

/** Verifies a token minted by signUnsubscribeToken. Returns the personId, or null if the token is malformed or the signature doesn't match. */
export function verifyUnsubscribeToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [personIdB64, signatureHex] = parts;

  let personId: string;
  try {
    personId = Buffer.from(personIdB64, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const expectedHex = crypto.createHmac("sha256", secret()).update(personId).digest("hex");
  const incoming = Buffer.from(signatureHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  if (incoming.length !== expected.length || !crypto.timingSafeEqual(incoming, expected)) {
    return null;
  }
  return personId;
}
