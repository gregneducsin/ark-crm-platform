import crypto from "node:crypto";
import argon2 from "argon2";

// Opaque-token primitives (generateRawToken, hashToken, timingSafeEqualString)
// live in @luma/shared — packages/db's seed.ts needs them too (to generate
// the bootstrap-admin invitation token) and shouldn't have to depend on
// apps/api to get them.
export { generateRawToken, hashToken, timingSafeEqualString } from "@luma/shared";

// ── Password hashing ──────────────────────────────────────────────────────────
// Stays here, not in @luma/shared: argon2 needs a native binding, which only
// apps/api's runtime actually loads.

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

// Precomputed hash of a random, unguessable value. Used so that "user not
// found" and "password mismatch" take statistically indistinguishable time —
// login always calls either verifyPassword(realHash, ...) or
// verifyPassword(dummyHash, ...), never skipping the hash-compare step.
let dummyHashPromise: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(crypto.randomBytes(32).toString("hex"));
  }
  return dummyHashPromise;
}

export async function dummyVerify(): Promise<void> {
  const hash = await getDummyHash();
  await verifyPassword(hash, crypto.randomBytes(32).toString("hex")).catch(() => false);
}
