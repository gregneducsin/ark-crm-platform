import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db, appUsersTable, userSessionsTable } from "@luma/db";
import { hashToken } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";

export const SESSION_COOKIE = "ark_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Populates req.user / req.sessionId from the session cookie. Never throws —
 * an invalid, expired, or revoked session simply leaves the request
 * unauthenticated; route-level auth guards decide what to do with that.
 */
export async function sessionMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  req.user = null;
  req.sessionId = null;

  const rawToken = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (!rawToken) {
    next();
    return;
  }

  try {
    const tokenHash = hashToken(rawToken);
    const [row] = await db
      .select({
        sessionId: userSessionsTable.id,
        expiresAt: userSessionsTable.expiresAt,
        revokedAt: userSessionsTable.revokedAt,
        userId: appUsersTable.id,
        email: appUsersTable.email,
        firstName: appUsersTable.firstName,
        lastName: appUsersTable.lastName,
        role: appUsersTable.role,
        status: appUsersTable.status,
      })
      .from(userSessionsTable)
      .innerJoin(appUsersTable, eq(userSessionsTable.userId, appUsersTable.id))
      .where(eq(userSessionsTable.sessionTokenHash, tokenHash));

    if (
      !row ||
      row.revokedAt !== null ||
      row.expiresAt < new Date() ||
      row.status === "locked" ||
      row.status === "disabled"
    ) {
      next();
      return;
    }

    req.user = {
      id: row.userId,
      email: row.email,
      firstName: row.firstName,
      lastName: row.lastName,
      role: row.role,
      status: row.status,
    };
    req.sessionId = row.sessionId;

    // Fire-and-forget last-used touch — never blocks or fails the request.
    void db
      .update(userSessionsTable)
      .set({ lastUsedAt: new Date() })
      .where(eq(userSessionsTable.id, row.sessionId))
      .catch((err: unknown) => logger.warn({ err }, "session: failed to touch lastUsedAt"));
  } catch (err) {
    logger.error({ err }, "session: lookup failed");
  }

  next();
}
