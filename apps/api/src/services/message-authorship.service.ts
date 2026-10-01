import { inArray } from "drizzle-orm";
import { appUsersTable, db } from "@luma/db";

/** Resolve only recorded authors. Never infer a historical author from message content. */
export async function withStaffNames<T extends { sentByStaffEmail: string | null }>(messages: readonly T[]): Promise<(T & { sentByStaffName: string | null })[]> {
  const emails = [...new Set(messages.flatMap((m) => m.sentByStaffEmail ? [m.sentByStaffEmail.trim().toLowerCase()] : []))];
  const users = emails.length ? await db.select({ email: appUsersTable.normalizedEmail, firstName: appUsersTable.firstName, lastName: appUsersTable.lastName })
    .from(appUsersTable).where(inArray(appUsersTable.normalizedEmail, emails)) : [];
  const names = new Map(users.map((u) => [u.email, [u.firstName, u.lastName].filter(Boolean).join(" ").trim()]));
  return messages.map((m) => ({ ...m, sentByStaffName: m.sentByStaffEmail ? names.get(m.sentByStaffEmail.trim().toLowerCase()) || null : null }));
}
