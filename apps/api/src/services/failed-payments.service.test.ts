import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, failedPaymentEventsTable } from "@luma/db";
import { listFailedPayments, resolveFailedPayment, reopenFailedPayment } from "./failed-payments.service.js";

async function seedCustomer(firstName: string): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName, lastName: "Failed", email: `failed-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" })
    .returning({ id: customersTable.id });
  return row.id;
}

async function seedFailedPayment(overrides: Partial<typeof failedPaymentEventsTable.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(failedPaymentEventsTable)
    .values({
      externalEventId: crypto.randomUUID(),
      transactionId: crypto.randomUUID(),
      externalPersonId: crypto.randomUUID(),
      failureDate: new Date("2026-08-20T12:00:00Z"),
      rawPayload: {},
      ...overrides,
    })
    .returning({ id: failedPaymentEventsTable.id });
  return row.id;
}

describe("listFailedPayments", () => {
  it("returns open events by default, joined with the matched customer", async () => {
    const personId = await seedCustomer("Open");
    await seedFailedPayment({ personId, externalPersonId: personId, amount: "175.00", cardBrand: "Visa", cardLast4: "4242" });

    const items = await listFailedPayments("open");
    const match = items.find((i) => i.personId === personId);
    expect(match).toMatchObject({ firstName: "Open", lastName: "Failed", amount: "175.00", cardBrand: "Visa", cardLast4: "4242", resolutionStatus: "open" });
  });

  it("still returns an event with no matched customer, with null customer fields", async () => {
    const id = await seedFailedPayment({ personId: null, externalPersonId: "unmatched-ext-id" });

    const items = await listFailedPayments("open");
    const match = items.find((i) => i.id === id);
    expect(match).toMatchObject({ personId: null, firstName: null, externalPersonId: "unmatched-ext-id" });
  });

  it("excludes resolved events when filtering to open, and vice versa", async () => {
    const openId = await seedFailedPayment();
    const resolvedId = await seedFailedPayment({ resolutionStatus: "resolved", resolvedAt: new Date() });

    const openItems = await listFailedPayments("open");
    expect(openItems.some((i) => i.id === openId)).toBe(true);
    expect(openItems.some((i) => i.id === resolvedId)).toBe(false);

    const resolvedItems = await listFailedPayments("resolved");
    expect(resolvedItems.some((i) => i.id === resolvedId)).toBe(true);
    expect(resolvedItems.some((i) => i.id === openId)).toBe(false);

    const allItems = await listFailedPayments("all");
    expect(allItems.some((i) => i.id === openId)).toBe(true);
    expect(allItems.some((i) => i.id === resolvedId)).toBe(true);
  });
});

describe("resolveFailedPayment", () => {
  it("marks an event resolved, stamps resolvedAt, and stores the note", async () => {
    const id = await seedFailedPayment();

    const result = await resolveFailedPayment(id, "Customer paid over the phone.");
    expect(result).toEqual({ ok: true });

    const [row] = await db.select().from(failedPaymentEventsTable).where(eq(failedPaymentEventsTable.id, id));
    expect(row?.resolutionStatus).toBe("resolved");
    expect(row?.resolvedAt).not.toBeNull();
    expect(row?.notes).toBe("Customer paid over the phone.");
  });

  it("returns not_found for a nonexistent id", async () => {
    const result = await resolveFailedPayment("00000000-0000-0000-0000-000000000000", undefined);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("reopenFailedPayment", () => {
  it("moves a resolved event back to open and clears resolvedAt", async () => {
    const id = await seedFailedPayment({ resolutionStatus: "resolved", resolvedAt: new Date() });

    const result = await reopenFailedPayment(id);
    expect(result).toEqual({ ok: true });

    const [row] = await db.select().from(failedPaymentEventsTable).where(eq(failedPaymentEventsTable.id, id));
    expect(row?.resolutionStatus).toBe("open");
    expect(row?.resolvedAt).toBeNull();
  });

  it("refuses to reopen an event that's already open", async () => {
    const id = await seedFailedPayment();
    const result = await reopenFailedPayment(id);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});
