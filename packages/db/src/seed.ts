/**
 * Bootstrap-admin seeding. Deliberately separate from migrate.ts: mixing
 * schema DDL with env-dependent data seeding is exactly the kind of
 * concern-mixing this rebuild avoids (see ARCHITECTURE.md).
 *
 * Reads BOOTSTRAP_ADMIN_EMAILS (comma-separated), inserts each as an
 * app_users row with role=admin, status=invited, generates an invitation
 * token, and prints the one-time invitation link — this is the ONLY way a
 * fresh bootstrap admin can ever set a password and log in, so it must not
 * be skipped. The raw link is printed to stdout only when a fresh token is
 * issued; it is never persisted or logged again after this (only its
 * SHA-256 hash is stored, in user_invitation_tokens).
 *
 * Idempotent: safe to run on every boot. A user already present and
 * status=active is left untouched. A user already present but still
 * status=invited (never completed the invitation flow — e.g. the original
 * link expired or was lost before it was used) gets its outstanding
 * invitation tokens invalidated and a fresh one issued and printed, so
 * re-running seed (e.g. by redeploying) is always a safe way to recover
 * the invitation link.
 */
import { db, pool, appUsersTable, userInvitationTokensTable } from "./index.js";
import { generateRawToken, hashToken } from "@luma/shared";
import { and, eq, isNull, sql } from "drizzle-orm";

const ADVISORY_LOCK_KEY = 4271_9001_338n;
const INVITATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function parseAdminEmails(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)),
    ),
  ];
}

function invitationLink(rawToken: string): string {
  const base = process.env.WEB_PUBLIC_URL?.replace(/\/$/, "") ?? "";
  return `${base}/accept-invitation?token=${rawToken}`;
}

async function seedBootstrapAdmins(): Promise<void> {
  const emails = parseAdminEmails(process.env.BOOTSTRAP_ADMIN_EMAILS);

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [ADVISORY_LOCK_KEY.toString()]);
    try {
      if (emails.length === 0) {
        // eslint-disable-next-line no-console
        console.warn("seed: BOOTSTRAP_ADMIN_EMAILS is unset or empty — no bootstrap admin users seeded");
        return;
      }
      for (const email of emails) {
        const [inserted] = await db
          .insert(appUsersTable)
          .values({
            email,
            normalizedEmail: email,
            firstName: "",
            lastName: "",
            role: "admin",
            status: "invited",
            invitedAt: sql`now()`,
          })
          .onConflictDoNothing({ target: appUsersTable.normalizedEmail })
          .returning({ id: appUsersTable.id });

        let userId = inserted?.id;
        let logPrefix = "seed: bootstrap admin created";

        if (!userId) {
          const [existing] = await db
            .select({ id: appUsersTable.id, status: appUsersTable.status })
            .from(appUsersTable)
            .where(eq(appUsersTable.normalizedEmail, email));

          if (!existing || existing.status !== "invited") {
            // eslint-disable-next-line no-console
            console.log(`seed: bootstrap admin already present, skipping: ${email}`);
            continue;
          }

          userId = existing.id;
          logPrefix = "seed: bootstrap admin still invited — reissuing invitation";
          await db
            .update(userInvitationTokensTable)
            .set({ usedAt: new Date() })
            .where(and(eq(userInvitationTokensTable.userId, userId), isNull(userInvitationTokensTable.usedAt)));
        }

        const rawToken = generateRawToken();
        await db.insert(userInvitationTokensTable).values({
          userId,
          tokenHash: hashToken(rawToken),
          expiresAt: new Date(Date.now() + INVITATION_TOKEN_TTL_MS),
        });

        // eslint-disable-next-line no-console
        console.log(
          `${logPrefix}: ${email}\n` +
            `  Invitation link (expires in 24h, shown only this once):\n` +
            `  ${invitationLink(rawToken)}`,
        );
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [ADVISORY_LOCK_KEY.toString()]);
    }
  } finally {
    client.release();
  }
}

const isMain = process.argv[1] === new URL(import.meta.url).pathname;
if (isMain) {
  seedBootstrapAdmins()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("seed: fatal error", err);
      process.exit(1);
    });
}

export { seedBootstrapAdmins, parseAdminEmails };
