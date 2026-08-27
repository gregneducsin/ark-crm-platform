import { and, desc, eq } from "drizzle-orm";
import { db, customersTable, failedPaymentEventsTable } from "@luma/db";
import type { FailedPaymentItem, FailedPaymentResolutionStatus } from "@luma/shared";

/**
 * failed_payment_events has been written to since the failed-payment
 * correction feature shipped (see webhooks.service.ts's
 * handleBaskPaymentFailedWebhook), but nothing ever read it back — this is
 * the first surface that does. LEFT JOIN, not INNER: a failed-payment event
 * can arrive for a person we couldn't resolve (see the "could not resolve a
 * customer" warn log in the webhook handler), and that row still needs to
 * show up here for staff to investigate, just without customer details.
 */
async function listByStatus(status: FailedPaymentResolutionStatus | "all"): Promise<FailedPaymentItem[]> {
  const rows = await db
    .select({
      id: failedPaymentEventsTable.id,
      personId: failedPaymentEventsTable.personId,
      firstName: customersTable.firstName,
      lastName: customersTable.lastName,
      email: customersTable.email,
      phone: customersTable.phone,
      externalPersonId: failedPaymentEventsTable.externalPersonId,
      transactionId: failedPaymentEventsTable.transactionId,
      amount: failedPaymentEventsTable.amount,
      failureDate: failedPaymentEventsTable.failureDate,
      paymentMethodType: failedPaymentEventsTable.paymentMethodType,
      cardBrand: failedPaymentEventsTable.cardBrand,
      cardLast4: failedPaymentEventsTable.cardLast4,
      transactionResponse: failedPaymentEventsTable.transactionResponse,
      sourceStatus: failedPaymentEventsTable.sourceStatus,
      testMode: failedPaymentEventsTable.testMode,
      resolutionStatus: failedPaymentEventsTable.resolutionStatus,
      resolvedAt: failedPaymentEventsTable.resolvedAt,
      notes: failedPaymentEventsTable.notes,
      createdAt: failedPaymentEventsTable.createdAt,
    })
    .from(failedPaymentEventsTable)
    .leftJoin(customersTable, eq(customersTable.id, failedPaymentEventsTable.personId))
    .where(status === "all" ? undefined : eq(failedPaymentEventsTable.resolutionStatus, status))
    .orderBy(desc(failedPaymentEventsTable.failureDate));

  return rows.map((r) => ({
    ...r,
    resolutionStatus: r.resolutionStatus as FailedPaymentResolutionStatus,
    failureDate: r.failureDate.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function listFailedPayments(status: FailedPaymentResolutionStatus | "all" = "open"): Promise<FailedPaymentItem[]> {
  return listByStatus(status);
}

export type ResolveFailedPaymentResult = { ok: true } | { ok: false; reason: "not_found" };

export async function resolveFailedPayment(id: string, notes: string | undefined): Promise<ResolveFailedPaymentResult> {
  const [updated] = await db
    .update(failedPaymentEventsTable)
    .set({ resolutionStatus: "resolved", resolvedAt: new Date(), notes: notes ?? undefined, updatedAt: new Date() })
    .where(eq(failedPaymentEventsTable.id, id))
    .returning({ id: failedPaymentEventsTable.id });
  return updated ? { ok: true } : { ok: false, reason: "not_found" };
}

export async function reopenFailedPayment(id: string): Promise<ResolveFailedPaymentResult> {
  const [updated] = await db
    .update(failedPaymentEventsTable)
    .set({ resolutionStatus: "open", resolvedAt: null, updatedAt: new Date() })
    .where(and(eq(failedPaymentEventsTable.id, id), eq(failedPaymentEventsTable.resolutionStatus, "resolved")))
    .returning({ id: failedPaymentEventsTable.id });
  return updated ? { ok: true } : { ok: false, reason: "not_found" };
}
