import cors from "cors";
import { env } from "../lib/env.js";

/**
 * Explicit origin allowlist — never `origin: true` (reflect-all). An empty
 * allowlist (the production default when CORS_ALLOWED_ORIGINS is unset)
 * rejects every cross-origin browser request, which is the safe failure
 * direction: a misconfigured deploy fails closed, not open.
 */
export const corsMiddleware = cors({
  credentials: true,
  origin(origin, callback) {
    // No Origin header (curl, server-to-server, same-origin) — allow.
    if (!origin) {
      callback(null, true);
      return;
    }
    if (env.corsAllowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Origin "${origin}" is not allowed.`));
  },
});
