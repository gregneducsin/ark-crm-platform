import type { AuthUser } from "@luma/shared";

declare global {
  namespace Express {
    interface Request {
      /** Populated by the session middleware. Null when unauthenticated. */
      user: AuthUser | null;
      /** The app_users session row id, when authenticated. */
      sessionId: string | null;
      /** Raw request body bytes, stashed by express.json()'s verify hook — see app.ts. Used by the iBluSend webhook's HMAC signature check. */
      rawBody?: Buffer;
    }
  }
}

export {};
