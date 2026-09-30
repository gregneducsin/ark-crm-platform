import { describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, customersTable, purchasesTable, failedPaymentEventsTable, webhookEventsTable, supportConversationsTable, supportEmailConversationsTable, type PurchaseStatus } from "@luma/db";

vi.mock("../lib/slack.js", () => ({ notifySlack: vi.fn(), notifySmsSlack: vi.fn() }));
const { handleBaskPaymentSucceededWebhook } = await import("./webhooks.service.js");

async function seed(status: PurchaseStatus = "payment_failed") {
  const key = crypto.randomUUID();
  const email = `${key}@example.com`;
  const [customer] = await db.insert(customersTable).values({ firstName: "Synthetic", lastName: "Recovery", email, leadReceivedDate: "2026-01-01" }).returning();
  const [purchase] = await db.insert(purchasesTable).values({ customerId: customer.id, purchaseDate: "2026-01-01", orderNumber: key, productName: "Test product", amountPaid: "100.00", ecommerceOrderId: key, status }).returning();
  const [failure] = await db.insert(failedPaymentEventsTable).values({ externalEventId: `failure-${key}`, transactionId: key, personId: customer.id, externalPersonId: key, failureDate: new Date(), rawPayload: {}, notes: "synthetic_failure" }).returning();
  const payload = { eventId: `success-${key}`, transactionId: key, externalPersonId: key, email };
  return { purchase, failure, payload };
}

async function state(s: Awaited<ReturnType<typeof seed>>) {
  const [purchase] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, s.purchase.id));
  const [failure] = await db.select().from(failedPaymentEventsTable).where(eq(failedPaymentEventsTable.id, s.failure.id));
  const [event] = await db.select().from(webhookEventsTable).where(and(eq(webhookEventsTable.source, "bask_payment_succeeded"), eq(webhookEventsTable.externalEventId, s.payload.eventId)));
  return { purchase, failure, event };
}

describe("atomic payment recovery", () => {
  it("rolls back the purchase when failure resolution throws, then retries the same event successfully", async () => {
    const s = await seed();
    // Test database only: inject a real database failure on the second write.
    await db.execute(sql.raw(`CREATE FUNCTION reject_test_payment_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.notes = 'synthetic_failure' AND NEW.resolution_status = 'resolved' THEN
          RAISE EXCEPTION 'injected recovery failure';
        END IF;
        RETURN NEW;
      END $$`));
    try {
      await db.execute(sql.raw(`CREATE TRIGGER reject_test_payment_recovery BEFORE UPDATE ON failed_payment_events FOR EACH ROW EXECUTE FUNCTION reject_test_payment_recovery()`));
      await expect(handleBaskPaymentSucceededWebhook(s.payload)).rejects.toThrow();
      const failed = await state(s);
      expect(failed.purchase.status).toBe("payment_failed");
      expect(failed.failure.resolutionStatus).toBe("open");
      expect(failed.failure.recoveredPurchaseId).toBeNull();
      expect(failed.event.status).toBe("failed");
    } finally {
      await db.execute(sql.raw("DROP TRIGGER IF EXISTS reject_test_payment_recovery ON failed_payment_events"));
      await db.execute(sql.raw("DROP FUNCTION reject_test_payment_recovery()"));
    }
    expect(await handleBaskPaymentSucceededWebhook(s.payload)).toEqual({ duplicate: false });
    const recovered = await state(s);
    expect(recovered.purchase.status).toBe("completed");
    expect(recovered.failure).toMatchObject({ resolutionStatus: "resolved", recoveredPurchaseId: s.purchase.id, recoveredTransactionId: s.payload.transactionId });
    expect(recovered.event.status).toBe("processed");
    expect(await handleBaskPaymentSucceededWebhook(s.payload)).toEqual({ duplicate: true });
    expect((await state(s)).failure.resolvedAt).toEqual(recovered.failure.resolvedAt);
  });

  it("repairs an already-completed purchase with an unresolved failure", async () => {
    const s = await seed("completed");
    await handleBaskPaymentSucceededWebhook(s.payload);
    const recovered = await state(s);
    expect(recovered.purchase.status).toBe("completed");
    expect(recovered.failure.resolutionStatus).toBe("resolved");
    expect(recovered.failure.recoveredPurchaseId).toBe(s.purchase.id);
  });

  it.each(["refunded", "cancelled", "pending"] as const)("does not recover an order in %s state", async status => {
    const s = await seed(status);
    await handleBaskPaymentSucceededWebhook(s.payload);
    const unchanged = await state(s);
    expect(unchanged.purchase.status).toBe(status);
    expect(unchanged.failure.resolutionStatus).toBe("open");
  });

  it("serializes two distinct success events without rewriting a resolved failure", async () => {
    const s = await seed();
    await Promise.all([handleBaskPaymentSucceededWebhook(s.payload), handleBaskPaymentSucceededWebhook({ ...s.payload, eventId: `${s.payload.eventId}-second` })]);
    const recovered = await state(s);
    expect(recovered.purchase.status).toBe("completed");
    expect(recovered.failure.resolutionStatus).toBe("resolved");
    await handleBaskPaymentSucceededWebhook({ ...s.payload, eventId: `${s.payload.eventId}-third` });
    expect((await state(s)).failure.resolvedAt).toEqual(recovered.failure.resolvedAt);
  });
});

describe("Sophie payment state after confirmed recovery", () => {
  it("clears SMS/email payment state while preserving staff review flags", async () => {
    const s = await seed();
    for (const table of [supportConversationsTable, supportEmailConversationsTable]) {
      await db.insert(table).values({ personId: s.purchase.customerId, paymentFailed: true, paymentFailedAt: new Date(), needsAttention: true, needsAttentionReason: "Unrelated clinical review" });
    }
    await handleBaskPaymentSucceededWebhook(s.payload);
    for (const table of [supportConversationsTable, supportEmailConversationsTable]) {
      const [row] = await db.select().from(table).where(eq(table.personId, s.purchase.customerId));
      expect(row.paymentFailed).toBe(false);
      expect(row.paymentFailedAt).toBeNull();
      expect(row.needsAttention).toBe(true);
      expect(row.needsAttentionReason).toBe("Unrelated clinical review");
    }
  });

  it("keeps payment failure state while another failed order remains", async () => {
    const s = await seed();
    const [conversation] = await db.insert(supportConversationsTable).values({ personId: s.purchase.customerId, paymentFailed: true, paymentFailedAt: new Date() }).returning();
    const otherKey = crypto.randomUUID();
    await db.insert(purchasesTable).values({ customerId: s.purchase.customerId, purchaseDate: "2026-01-01", orderNumber: otherKey, productName: "Test product", amountPaid: "100.00", ecommerceOrderId: otherKey, status: "payment_failed" });
    await handleBaskPaymentSucceededWebhook(s.payload);
    const [row] = await db.select().from(supportConversationsTable).where(eq(supportConversationsTable.id, conversation.id));
    expect(row.paymentFailed).toBe(true);
    expect(row.paymentFailedAt).toEqual(conversation.paymentFailedAt);
  });

  it("keeps state for another unresolved failure even without a matched order", async () => {
    const s = await seed();
    await db.insert(supportConversationsTable).values({ personId: s.purchase.customerId, paymentFailed: true });
    const otherKey = crypto.randomUUID();
    await db.insert(failedPaymentEventsTable).values({ externalEventId: otherKey, transactionId: otherKey, personId: s.purchase.customerId, externalPersonId: s.payload.externalPersonId, failureDate: new Date(), rawPayload: {} });
    await handleBaskPaymentSucceededWebhook(s.payload);
    const [row] = await db.select().from(supportConversationsTable).where(eq(supportConversationsTable.personId, s.purchase.customerId));
    expect(row.paymentFailed).toBe(true);
  });
});
