import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { timingSafeEqualString } from "../lib/crypto.js";

export const WEBHOOK_SECRET_HEADER = "x-webhook-secret";

/**
 * Shared-secret header auth for inbound webhooks, constant-time compared.
 * This is NOT a cryptographic signature over the payload (no HMAC) — it's a
 * shared static secret, same tier of guarantee as the old app's webhook
 * auth. Kept deliberately separate from CSRF (never mounted on /api/app/*)
 * and from session auth — webhook callers aren't browsers and carry
 * neither a session cookie nor a CSRF token.
 */
export function createWebhookAuth(secretEnvVar: string) {
  return function webhookAuth(req: Request, res: Response, next: NextFunction): void {
    const expected = process.env[secretEnvVar];
    if (!expected) {
      res.status(500).json({ error: `Webhook secret ${secretEnvVar} is not configured.` });
      return;
    }
    const incoming = req.header(WEBHOOK_SECRET_HEADER);
    if (!incoming || !timingSafeEqualString(incoming, expected)) {
      res.status(401).json({ error: "Invalid or missing X-Webhook-Secret." });
      return;
    }
    next();
  };
}

const IBLUSEND_SIGNATURE_HEADER = "x-iblusend-signature";

/**
 * HMAC-SHA256-over-the-raw-body auth, per iBluSend's documented scheme:
 * header is `sha256=<hex HMAC-SHA256(secret, raw body)>`. Requires
 * express.json()'s verify hook to have stashed req.rawBody (see app.ts) —
 * req.body has already been JSON.parse'd by this point and re-serializing
 * it is not guaranteed to reproduce the exact bytes that were signed.
 *
 * timingSafeEqual throws on a length mismatch rather than returning false,
 * so the length check happens first — same fail-closed pattern as
 * timingSafeEqualString.
 */
export function createIbluSendWebhookAuth(secretEnvVar: string) {
  return function ibluSendWebhookAuth(req: Request, res: Response, next: NextFunction): void {
    const secret = process.env[secretEnvVar];
    if (!secret) {
      res.status(500).json({ error: `Webhook secret ${secretEnvVar} is not configured.` });
      return;
    }
    if (!req.rawBody) {
      res.status(500).json({ error: "Raw request body was not captured; cannot verify signature." });
      return;
    }
    const header = req.header(IBLUSEND_SIGNATURE_HEADER);
    const prefix = "sha256=";
    if (!header || !header.startsWith(prefix)) {
      res.status(401).json({ error: "Invalid or missing X-iBluSend-Signature." });
      return;
    }
    const incomingHex = header.slice(prefix.length);
    const expectedHex = crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");

    const incoming = Buffer.from(incomingHex, "hex");
    const expected = Buffer.from(expectedHex, "hex");
    if (incoming.length !== expected.length || !crypto.timingSafeEqual(incoming, expected)) {
      res.status(401).json({ error: "Invalid or missing X-iBluSend-Signature." });
      return;
    }
    next();
  };
}
