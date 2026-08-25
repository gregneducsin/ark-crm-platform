import type { NextFunction, Request, Response } from "express";
import { generateRawToken, timingSafeEqualString } from "../lib/crypto.js";

export const CSRF_COOKIE = "ark_csrf";
export const CSRF_HEADER = "x-csrf-token";

/**
 * Double-submit cookie CSRF defense. The cookie is intentionally NOT
 * httpOnly — the client must be able to read it and echo it back as a
 * header, which is the entire point: a cross-site attacker can trigger a
 * request that carries the cookie automatically, but cannot read the
 * cookie's value to also set the matching header, since browsers do not
 * allow cross-origin reads of another site's cookies.
 *
 * GET /api/app/auth/csrf-token (see auth.routes.ts) issues the cookie if
 * absent and returns the token in the JSON body so the client can store it
 * for subsequent mutating requests.
 */
export function issueCsrfCookieIfMissing(req: Request, res: Response): string {
  const existing = req.cookies?.[CSRF_COOKIE] as string | undefined;
  if (existing) return existing;

  const token = generateRawToken();
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  return token;
}

export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const cookieToken = req.cookies?.[CSRF_COOKIE] as string | undefined;
  const headerToken = req.header(CSRF_HEADER);

  if (!cookieToken || !headerToken || !timingSafeEqualString(cookieToken, headerToken)) {
    res.status(403).json({ error: "Invalid or missing CSRF token." });
    return;
  }
  next();
}
