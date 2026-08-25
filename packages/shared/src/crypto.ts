import crypto from "node:crypto";

/**
 * Opaque token primitives shared between packages/db (seed.ts, which needs
 * to generate the bootstrap-admin invitation token) and apps/api (session,
 * password-reset, and invitation-redemption flows). Deliberately excludes
 * argon2 password hashing — that stays in apps/api since it's the only
 * place that needs the native binding at runtime.
 *
 * The raw token is returned to the caller exactly once and is never
 * stored — only its SHA-256 hash is persisted.
 */
export function generateRawToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
