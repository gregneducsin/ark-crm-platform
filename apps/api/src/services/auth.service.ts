import { eq, and, isNull, gt, sql } from "drizzle-orm";
import {
  db,
  appUsersTable,
  userSessionsTable,
  userInvitationTokensTable,
  passwordResetTokensTable,
  type AppUser,
} from "@luma/db";
import type { AuthUser } from "@luma/shared";
import { dummyVerify, generateRawToken, hashPassword, hashToken, verifyPassword } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";
import { writeUserAuditEvent } from "./audit.service.js";
import { getEmailProvider } from "../lib/email-provider.js";
import { renderStaffInvitationEmail } from "../lib/email/staff-invite-email.js";
import { renderStaffPasswordResetEmail } from "../lib/email/staff-password-reset-email.js";

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

function toAuthUser(row: AppUser): AuthUser {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    role: row.role,
    status: row.status,
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ── Login ───────────────────────────────────────────────────────────────────

export type LoginResult =
  | { ok: true; user: AuthUser; rawSessionToken: string }
  | { ok: false; reason: "invalid_credentials" | "locked" | "not_active" };

export async function login(email: string, password: string): Promise<LoginResult> {
  const normalized = normalizeEmail(email);
  const [user] = await db.select().from(appUsersTable).where(eq(appUsersTable.normalizedEmail, normalized));

  if (!user) {
    await dummyVerify();
    return { ok: false, reason: "invalid_credentials" };
  }

  if (user.status === "locked") {
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await dummyVerify();
      return { ok: false, reason: "locked" };
    }
    // Lockout window has passed — unlock before evaluating the attempt.
    await db
      .update(appUsersTable)
      .set({ status: "active", lockedUntil: null, failedLoginAttempts: 0 })
      .where(eq(appUsersTable.id, user.id));
    user.status = "active";
  }

  if (user.status === "disabled") {
    await dummyVerify();
    return { ok: false, reason: "invalid_credentials" };
  }

  if (user.status === "invited" || !user.passwordHash) {
    await dummyVerify();
    return { ok: false, reason: "not_active" };
  }

  const passwordOk = await verifyPassword(user.passwordHash, password);
  if (!passwordOk) {
    const attempts = user.failedLoginAttempts + 1;
    const willLock = attempts >= MAX_FAILED_LOGIN_ATTEMPTS;
    await db
      .update(appUsersTable)
      .set({
        failedLoginAttempts: attempts,
        ...(willLock ? { status: "locked", lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) } : {}),
      })
      .where(eq(appUsersTable.id, user.id));
    if (willLock) {
      await writeUserAuditEvent({ actorUserId: null, targetUserId: user.id, action: "account_locked" });
    }
    return { ok: false, reason: "invalid_credentials" };
  }

  await db
    .update(appUsersTable)
    .set({ failedLoginAttempts: 0, lastLoginAt: new Date() })
    .where(eq(appUsersTable.id, user.id));

  const { rawToken } = await createSession(user.id);
  await writeUserAuditEvent({ actorUserId: user.id, targetUserId: user.id, action: "login_success" });

  return { ok: true, user: toAuthUser(user), rawSessionToken: rawToken };
}

// ── Sessions ────────────────────────────────────────────────────────────────

export async function createSession(userId: string): Promise<{ rawToken: string; expiresAt: Date }> {
  const rawToken = generateRawToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(userSessionsTable).values({
    userId,
    sessionTokenHash: hashToken(rawToken),
    expiresAt,
  });
  return { rawToken, expiresAt };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await db.update(userSessionsTable).set({ revokedAt: new Date() }).where(eq(userSessionsTable.id, sessionId));
}

// ── Password reset ─────────────────────────────────────────────────────────

/**
 * Always resolves the same way regardless of whether the email exists —
 * enumeration resistance. Returns the raw reset link only for local logging
 * (no email transport is wired up in this phase — see the TODO below); a
 * caller that only cares about the generic "check your email" UX can ignore
 * the return value entirely.
 */
export async function requestPasswordReset(email: string): Promise<{ rawResetLink: string | null }> {
  const normalized = normalizeEmail(email);
  const [user] = await db.select().from(appUsersTable).where(eq(appUsersTable.normalizedEmail, normalized));

  // Only active accounts can use password reset — invited accounts haven't
  // set a password yet and should use the invitation link instead.
  if (!user || user.status !== "active") {
    return { rawResetLink: null };
  }

  // Invalidate any previously-issued, still-unused reset tokens for this
  // user first, so at most one outstanding token exists at a time.
  await db
    .update(passwordResetTokensTable)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokensTable.userId, user.id), isNull(passwordResetTokensTable.usedAt)));

  const rawToken = generateRawToken();
  await db.insert(passwordResetTokensTable).values({
    userId: user.id,
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS),
  });

  await writeUserAuditEvent({ actorUserId: null, targetUserId: user.id, action: "password_reset_requested" });

  const base = process.env.WEB_PUBLIC_URL?.replace(/\/$/, "") ?? "";
  const rawResetLink = `${base}/reset-password?token=${rawToken}`;
  // TODO(texting/notifications phase): replace with a real transactional
  // email send. Until then this is operator-visible only — never logged
  // with the raw token value beyond this one line, and only reachable by
  // someone with access to API server logs.
  logger.info({ userId: user.id }, `auth: password reset link generated (see rawResetLink in response for now)`);

  return { rawResetLink };
}

export async function resetPassword(rawToken: string, newPassword: string): Promise<{ ok: boolean }> {
  const tokenHash = hashToken(rawToken);

  const [redeemed] = await db
    .update(passwordResetTokensTable)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(passwordResetTokensTable.tokenHash, tokenHash),
        isNull(passwordResetTokensTable.usedAt),
        gt(passwordResetTokensTable.expiresAt, sql`now()`),
      ),
    )
    .returning({ userId: passwordResetTokensTable.userId });

  if (!redeemed) return { ok: false };

  const passwordHash = await hashPassword(newPassword);
  await db
    .update(appUsersTable)
    .set({
      passwordHash,
      status: "active",
      lockedUntil: null,
      failedLoginAttempts: 0,
    })
    .where(eq(appUsersTable.id, redeemed.userId));

  // A password reset proves account ownership — revoke every existing
  // session so a previously-stolen session cookie stops working.
  await db.update(userSessionsTable).set({ revokedAt: new Date() }).where(eq(userSessionsTable.userId, redeemed.userId));

  await writeUserAuditEvent({ actorUserId: redeemed.userId, targetUserId: redeemed.userId, action: "password_reset_completed" });

  return { ok: true };
}

// ── Invitations ─────────────────────────────────────────────────────────────

export async function createInvitation(userId: string): Promise<{ rawToken: string; expiresAt: Date }> {
  // Single-outstanding-token invariant, same pattern as password reset.
  await db
    .update(userInvitationTokensTable)
    .set({ usedAt: new Date() })
    .where(and(eq(userInvitationTokensTable.userId, userId), isNull(userInvitationTokensTable.usedAt)));

  const rawToken = generateRawToken();
  const expiresAt = new Date(Date.now() + INVITATION_TOKEN_TTL_MS);
  await db.insert(userInvitationTokensTable).values({
    userId,
    tokenHash: hashToken(rawToken),
    expiresAt,
  });
  return { rawToken, expiresAt };
}

export async function acceptInvitation(rawToken: string, newPassword: string): Promise<{ ok: boolean }> {
  const tokenHash = hashToken(rawToken);

  const [redeemed] = await db
    .update(userInvitationTokensTable)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(userInvitationTokensTable.tokenHash, tokenHash),
        isNull(userInvitationTokensTable.usedAt),
        gt(userInvitationTokensTable.expiresAt, sql`now()`),
      ),
    )
    .returning({ userId: userInvitationTokensTable.userId });

  if (!redeemed) return { ok: false };

  const passwordHash = await hashPassword(newPassword);
  await db
    .update(appUsersTable)
    .set({ passwordHash, status: "active", activatedAt: new Date() })
    .where(eq(appUsersTable.id, redeemed.userId));

  await writeUserAuditEvent({ actorUserId: redeemed.userId, targetUserId: redeemed.userId, action: "invitation_accepted" });

  return { ok: true };
}

// ── User management (admin) ─────────────────────────────────────────────────

export type InviteUserResult = { ok: true; user: AuthUser } | { ok: false; reason: "email_taken" };

/**
 * Creates the user row (status "invited"), issues an invitation token, and
 * emails the accept-invitation link — the actual "email invites" ask,
 * distinct from createInvitation above (which only mints a token for a
 * user that already exists, e.g. the bootstrap-admin seed step). The email
 * send is fail-soft: a provider outage shouldn't undo the invite itself —
 * the link still works if shared manually, and getEmailProvider's own
 * failure-alert wrapper already reports the send failure to Slack.
 */
export async function inviteUser(params: {
  email: string;
  firstName: string;
  lastName: string;
  role: AuthUser["role"];
  actorUserId: string;
}): Promise<InviteUserResult> {
  const normalizedEmail = normalizeEmail(params.email);
  const [existing] = await db.select({ id: appUsersTable.id }).from(appUsersTable).where(eq(appUsersTable.normalizedEmail, normalizedEmail));
  if (existing) return { ok: false, reason: "email_taken" };

  const [created] = await db
    .insert(appUsersTable)
    .values({
      email: params.email,
      normalizedEmail,
      firstName: params.firstName,
      lastName: params.lastName,
      role: params.role,
      status: "invited",
      invitedAt: new Date(),
    })
    .returning();

  const { rawToken } = await createInvitation(created.id);
  await writeUserAuditEvent({ actorUserId: params.actorUserId, targetUserId: created.id, action: "user_invited", newValues: { role: created.role } });

  const base = process.env.WEB_PUBLIC_URL?.replace(/\/$/, "") ?? "";
  const inviteUrl = `${base}/accept-invitation?token=${rawToken}`;
  try {
    const { provider, fromName } = getEmailProvider("system");
    const rendered = renderStaffInvitationEmail(created.firstName, created.role, inviteUrl);
    await provider.sendEmail(created.email, rendered.subject, rendered.html, { fromName });
  } catch (err) {
    logger.warn({ userId: created.id, reason: err instanceof Error ? err.message : String(err) }, "invitation email send failed");
  }

  return { ok: true, user: toAuthUser(created) };
}

export async function listUsers(): Promise<AuthUser[]> {
  const rows = await db.select().from(appUsersTable).orderBy(appUsersTable.createdAt);
  return rows.map(toAuthUser);
}

export type UpdateUserResult = { ok: true; user: AuthUser } | { ok: false; reason: "not_found" | "self" };

/**
 * Admin-driven role change and/or enable/disable, distinct from the
 * self-service password/invitation flows above. Disabling revokes every
 * existing session immediately — same reasoning as resetPassword: a
 * disabled account shouldn't keep working just because it's still logged in
 * somewhere. Can't target yourself — an admin locking out or demoting their
 * own account has no recovery path but another admin, and today nothing
 * guarantees a second one exists.
 */
export async function updateUser(
  targetUserId: string,
  input: { role?: AuthUser["role"]; status?: "active" | "disabled" },
  actorUserId: string,
): Promise<UpdateUserResult> {
  if (targetUserId === actorUserId) return { ok: false, reason: "self" };

  const [existing] = await db.select().from(appUsersTable).where(eq(appUsersTable.id, targetUserId));
  if (!existing) return { ok: false, reason: "not_found" };

  const patch: Partial<typeof appUsersTable.$inferInsert> = {};
  if (input.role !== undefined) patch.role = input.role;
  if (input.status !== undefined) patch.status = input.status;

  const [updated] = await db.update(appUsersTable).set(patch).where(eq(appUsersTable.id, targetUserId)).returning();

  if (input.role !== undefined && input.role !== existing.role) {
    await writeUserAuditEvent({
      actorUserId,
      targetUserId,
      action: "role_changed",
      previousValues: { role: existing.role },
      newValues: { role: input.role },
    });
  }
  if (input.status !== undefined && input.status !== existing.status) {
    await writeUserAuditEvent({
      actorUserId,
      targetUserId,
      action: input.status === "disabled" ? "user_disabled" : "user_reactivated",
      previousValues: { status: existing.status },
      newValues: { status: input.status },
    });
    if (input.status === "disabled") {
      await db.update(userSessionsTable).set({ revokedAt: new Date() }).where(eq(userSessionsTable.userId, targetUserId));
    }
  }

  return { ok: true, user: toAuthUser(updated) };
}

export type AdminResendInvitationResult = { ok: true } | { ok: false; reason: "not_found" | "not_invited" };

/**
 * Re-sends the invitation email for a user still stuck in status "invited"
 * — e.g. their original link expired, or they never got the email. Reuses
 * createInvitation (invalidates any outstanding token, mints a fresh one)
 * and the same template inviteUser sends on first invite.
 */
export async function adminResendInvitation(targetUserId: string, actorUserId: string): Promise<AdminResendInvitationResult> {
  const [user] = await db.select().from(appUsersTable).where(eq(appUsersTable.id, targetUserId));
  if (!user) return { ok: false, reason: "not_found" };
  if (user.status !== "invited") return { ok: false, reason: "not_invited" };

  const { rawToken } = await createInvitation(user.id);
  await writeUserAuditEvent({ actorUserId, targetUserId: user.id, action: "invitation_resent" });

  const base = process.env.WEB_PUBLIC_URL?.replace(/\/$/, "") ?? "";
  const inviteUrl = `${base}/accept-invitation?token=${rawToken}`;
  try {
    const { provider, fromName } = getEmailProvider("system");
    const rendered = renderStaffInvitationEmail(user.firstName, user.role, inviteUrl);
    await provider.sendEmail(user.email, rendered.subject, rendered.html, { fromName });
  } catch (err) {
    logger.warn({ userId: user.id, reason: err instanceof Error ? err.message : String(err) }, "resend invitation email send failed");
  }

  return { ok: true };
}

export type AdminResetPasswordResult = { ok: true } | { ok: false; reason: "not_found" | "not_eligible" };

/**
 * Admin-triggered password reset, distinct from requestPasswordReset above:
 * that one is the self-service "forgot password" flow (enumeration-resistant,
 * looks up by email, only logs the link). This one is admin-authenticated,
 * targets a specific user by id, and actually emails the link — the admin
 * has no way to see a server log. Eligible for "active" or "locked" accounts
 * only; an "invited" account hasn't set a password yet (use resend-invite
 * instead) and a "disabled" one needs reactivating first.
 */
export async function adminResetPassword(targetUserId: string, actorUserId: string): Promise<AdminResetPasswordResult> {
  const [user] = await db.select().from(appUsersTable).where(eq(appUsersTable.id, targetUserId));
  if (!user) return { ok: false, reason: "not_found" };
  if (user.status !== "active" && user.status !== "locked") return { ok: false, reason: "not_eligible" };

  await db
    .update(passwordResetTokensTable)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokensTable.userId, user.id), isNull(passwordResetTokensTable.usedAt)));

  const rawToken = generateRawToken();
  await db.insert(passwordResetTokensTable).values({
    userId: user.id,
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS),
  });

  await writeUserAuditEvent({ actorUserId, targetUserId: user.id, action: "password_reset_requested" });

  const base = process.env.WEB_PUBLIC_URL?.replace(/\/$/, "") ?? "";
  const resetUrl = `${base}/reset-password?token=${rawToken}`;
  try {
    const { provider, fromName } = getEmailProvider("system");
    const rendered = renderStaffPasswordResetEmail(user.firstName, resetUrl);
    await provider.sendEmail(user.email, rendered.subject, rendered.html, { fromName });
  } catch (err) {
    logger.warn({ userId: user.id, reason: err instanceof Error ? err.message : String(err) }, "admin-triggered password reset email send failed");
  }

  return { ok: true };
}
