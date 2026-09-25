import { eq } from "drizzle-orm";
import { db, smsPhoneOptOutsTable } from "@luma/db";
import { normalizePhone } from "./phone.js";

/** Independent of customer records: creating or purchasing on an account
 * must not erase a STOP received before that account existed. */
export async function recordPhoneSmsOptOut(phone: string): Promise<void> {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error("Cannot record SMS opt-out without a phone number");
  await db.insert(smsPhoneOptOutsTable).values({ phone: normalized }).onConflictDoNothing();
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function isPhoneSmsOptedOut(phone: string, tx?: Tx): Promise<boolean> {
  if (!phone.trim()) return false;
  const [row] = await (tx ?? db).select({ phone: smsPhoneOptOutsTable.phone }).from(smsPhoneOptOutsTable)
    .where(eq(smsPhoneOptOutsTable.phone, normalizePhone(phone)));
  return Boolean(row);
}

export class SmsOptOutError extends Error {
  constructor() {
    super("SMS was not sent: this phone number has opted out.");
    this.name = "SmsOptOutError";
  }
}

export async function assertPhoneSmsAllowed(phone: string): Promise<void> {
  if (await isPhoneSmsOptedOut(phone)) throw new SmsOptOutError();
}
