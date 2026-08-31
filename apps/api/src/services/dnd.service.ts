import { and, eq, ne, sql } from "drizzle-orm";
import { db, customersTable, purchasesTable } from "@luma/db";
import { phoneMatchKey } from "../lib/phone.js";

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

/**
 * Silences every OTHER, not-yet-purchased customer record that shares this
 * customer's phone number — e.g. duplicate lead signups (a test entry, a
 * form filled out twice, a mismatched intake) that were never the same
 * record as the one that actually bought. Without this, a genuine purchase
 * on one record left sibling records free to keep sending Alexis's
 * marketing texts/emails (abandoned-cart, objection follow-ups, etc.) to
 * that same real phone/inbox even after the person had already bought —
 * see findCustomerIdByPhone in iblusend-webhook.service.ts for the related
 * bug where an inbound reply could land on the wrong one of these records.
 *
 * Call this alongside clearing the purchaser's own DND flags (same call
 * sites: purchases.service.ts's createPurchase, webhooks.service.ts's
 * handleBaskOrderWebhook) — a purchase is fresh consent for the purchaser,
 * and the mirror image of that for everyone else sharing their number.
 *
 * Only touches siblings with no completed purchase of their own — a
 * sibling that's a real, separately-converted customer keeps its own DND
 * state untouched; this never un-silences anyone.
 */
export async function silenceOtherLeadsSharingPhone(purchasedCustomerId: string): Promise<void> {
  const [purchased] = await db.select({ phone: customersTable.phone }).from(customersTable).where(eq(customersTable.id, purchasedCustomerId));
  const key = phoneMatchKey(purchased?.phone ?? "");
  if (key.length !== 10) return;

  const now = new Date();
  await db
    .update(customersTable)
    .set({ dnd: true, dndAt: now, emailDnd: true, emailDndAt: now })
    .where(
      and(
        sql`right(regexp_replace(${customersTable.phone}, '\D', '', 'g'), 10) = ${key}`,
        ne(customersTable.id, purchasedCustomerId),
        sql`not exists (select 1 from ${purchasesTable} where ${purchasesTable.customerId} = ${customersTable.id} and ${purchasesTable.status} = 'completed')`,
      ),
    );
}
