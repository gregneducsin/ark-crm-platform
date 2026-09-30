import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db, appUsersTable, passwordResetTokensTable, userInvitationTokensTable, userSessionsTable } from "@luma/db";
import { resetPassword, acceptInvitation, updateUser, createSession } from "./auth.service.js";
import { hashToken } from "../lib/crypto.js";

describe("disabled staff token protection", () => {
  async function fixture(status: "active" | "invited" | "disabled") {
    const email = `${crypto.randomUUID()}@example.test`;
    const [user] = await db.insert(appUsersTable).values({ email, normalizedEmail: email, status, role: "customer_service" }).returning();
    const raw = crypto.randomUUID();
    const values = { userId: user.id, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + 60000) };
    await db.insert(passwordResetTokensTable).values(values);
    await db.insert(userInvitationTokensTable).values(values);
    return { user, raw };
  }
  it("atomically revokes sessions and both token types, including after re-enabling", async () => {
    const { user, raw } = await fixture("active");
    const { user: admin } = await fixture("active");
    await createSession(user.id);
    await updateUser(user.id, { status: "disabled" }, admin.id);
    for (const table of [passwordResetTokensTable, userInvitationTokensTable]) {
      const rows = await db.select().from(table).where(eq(table.userId, user.id));
      expect(rows.every(row => row.usedAt !== null)).toBe(true);
    }
    const sessions = await db.select().from(userSessionsTable).where(eq(userSessionsTable.userId, user.id));
    expect(sessions.every(row => row.revokedAt !== null)).toBe(true);
    expect(await resetPassword(raw, "NewPassword123!" )).toEqual({ ok: false });
    expect(await acceptInvitation(raw, "NewPassword123!" )).toEqual({ ok: false });
    await updateUser(user.id, { status: "active" }, admin.id);
    expect(await resetPassword(raw, "NewPassword123!" )).toEqual({ ok: false });
  });
  it("rejects still-unused legacy tokens on disabled accounts", async () => {
    const { user, raw } = await fixture("disabled");
    expect(await resetPassword(raw, "NewPassword123!" )).toEqual({ ok: false });
    expect(await acceptInvitation(raw, "NewPassword123!" )).toEqual({ ok: false });
    const [row] = await db.select().from(appUsersTable).where(eq(appUsersTable.id, user.id));
    expect(row.status).toBe("disabled");
    expect(row.passwordHash).toBeNull();
  });
  it("allows valid invitations and makes redemption single-use", async () => {
    const { raw } = await fixture("invited");
    const results = await Promise.all([acceptInvitation(raw, "NewPassword123!"), acceptInvitation(raw, "NewPassword123!")]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
  });
  it("keeps an account disabled when reset races with administrative disable", async () => {
    const { user, raw } = await fixture("active");
    const { user: admin } = await fixture("active");
    await Promise.all([resetPassword(raw, "NewPassword123!"), updateUser(user.id, { status: "disabled" }, admin.id)]);
    const [row] = await db.select().from(appUsersTable).where(eq(appUsersTable.id, user.id));
    expect(row.status).toBe("disabled");
  });
});
