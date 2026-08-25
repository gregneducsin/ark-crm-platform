import { pgTable, text, uuid, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { employeesTable } from "./payroll";

/**
 * Application users — email/password auth only. No OIDC, no legacy provider.
 */
export const appUsersTable = pgTable(
  "app_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    firstName: text("first_name").notNull().default(""),
    lastName: text("last_name").notNull().default(""),
    passwordHash: text("password_hash"),
    role: text("role", { enum: ["admin", "manager", "customer_service"] })
      .notNull()
      .default("customer_service"),
    status: text("status", { enum: ["invited", "active", "locked", "disabled"] })
      .notNull()
      .default("invited"),
    employeeId: uuid("employee_id").references(() => employeesTable.id, { onDelete: "set null" }),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("app_users_normalized_email_key").on(t.normalizedEmail),
    uniqueIndex("app_users_employee_id_key").on(t.employeeId),
    index("app_users_role_idx").on(t.role),
    index("app_users_status_idx").on(t.status),
  ],
);

/**
 * Opaque server-side session tokens. Only the SHA-256 hash of the raw token
 * is ever stored (or logged) — the raw token exists only in the browser's
 * httpOnly cookie and the response that issued it.
 */
export const userSessionsTable = pgTable(
  "user_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
    sessionTokenHash: text("session_token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("user_sessions_token_hash_key").on(t.sessionTokenHash),
    index("user_sessions_user_id_idx").on(t.userId),
    index("user_sessions_expires_at_idx").on(t.expiresAt),
  ],
);

export const userInvitationTokensTable = pgTable(
  "user_invitation_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("user_invitation_tokens_token_hash_key").on(t.tokenHash),
    index("user_invitation_tokens_user_id_idx").on(t.userId),
  ],
);

export const passwordResetTokensTable = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("password_reset_tokens_token_hash_key").on(t.tokenHash),
    index("password_reset_tokens_user_id_idx").on(t.userId),
  ],
);

/**
 * Append-only audit trail. This is the pattern future domains (payroll,
 * eventually messaging) follow — actor + action + before/after values,
 * never updated or deleted.
 */
export const userAuditEventsTable = pgTable(
  "user_audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
    targetUserId: uuid("target_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    previousValues: jsonb("previous_values"),
    newValues: jsonb("new_values"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("user_audit_events_actor_user_id_idx").on(t.actorUserId),
    index("user_audit_events_target_user_id_idx").on(t.targetUserId),
  ],
);

export type AppUser = typeof appUsersTable.$inferSelect;
export type InsertAppUser = typeof appUsersTable.$inferInsert;
export type UserSession = typeof userSessionsTable.$inferSelect;
