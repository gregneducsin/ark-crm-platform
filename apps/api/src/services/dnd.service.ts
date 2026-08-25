import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";

/**
 * SMS/iMessage and email opt-out are tracked independently (customers.dnd
 * vs customers.emailDnd) — a STOP reply on one channel must not silently
 * suppress the other. Every SMS send path must check isCustomerSmsDnd;
 * every email send path must check isCustomerEmailDnd.
 */

/** True once a customer has texted STOP/UNSUBSCRIBE and hasn't purchased since. */
export async function isCustomerSmsDnd(personId: string): Promise<boolean> {
  const [row] = await db.select({ dnd: customersTable.dnd }).from(customersTable).where(eq(customersTable.id, personId));
  return row?.dnd ?? false;
}

/**
 * Sets or clears a customer's SMS do-not-disturb flag. Set true on an
 * inbound STOP/UNSUBSCRIBE (see the OPT_OUT pre-check code in
 * alexis-dispatch.service.ts and sophie-dispatch.service.ts); cleared
 * automatically the moment the customer makes a purchase
 * (purchases.service.ts's createPurchase and webhooks.service.ts's
 * handleBaskOrderWebhook) — a purchase is treated as fresh consent to be
 * messaged again.
 */
export async function setCustomerSmsDnd(personId: string, dnd: boolean): Promise<void> {
  await db
    .update(customersTable)
    .set({ dnd, dndAt: dnd ? new Date() : null })
    .where(eq(customersTable.id, personId));
}

/** True once a customer has opted out of email (STOP-equivalent reply, or the unsubscribe link) and hasn't purchased since. */
export async function isCustomerEmailDnd(personId: string): Promise<boolean> {
  const [row] = await db.select({ emailDnd: customersTable.emailDnd }).from(customersTable).where(eq(customersTable.id, personId));
  return row?.emailDnd ?? false;
}

/**
 * Sets or clears a customer's email do-not-disturb flag. Set true on an
 * inbound OPT_OUT pre-check code (alexis-email-dispatch.service.ts /
 * sophie-email-dispatch.service.ts) or the one-click unsubscribe link every
 * automated email carries (email-unsubscribe.routes.ts); cleared
 * automatically on purchase, same reasoning as setCustomerSmsDnd.
 */
export async function setCustomerEmailDnd(personId: string, dnd: boolean): Promise<void> {
  await db
    .update(customersTable)
    .set({ emailDnd: dnd, emailDndAt: dnd ? new Date() : null })
    .where(eq(customersTable.id, personId));
}
