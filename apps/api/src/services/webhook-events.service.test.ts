import { describe, expect, it } from "vitest";
import { db, customersTable, webhookEventsTable } from "@luma/db";
import { listWebhookEvents } from "./webhook-events.service.js";

async function seedCustomer(firstName: string): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName, lastName: "Webhook", email: `webhook-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" })
    .returning({ id: customersTable.id });
  return row.id;
}

async function seedWebhookEvent(overrides: Partial<typeof webhookEventsTable.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(webhookEventsTable)
    .values({
      source: "bask_questionnaire",
      externalEventId: crypto.randomUUID(),
      rawPayload: { hello: "world" },
      ...overrides,
    })
    .returning({ id: webhookEventsTable.id });
  return row.id;
}

describe("listWebhookEvents", () => {
  it("returns events newest first, joined with the matched customer's name", async () => {
    const personId = await seedCustomer("Wanda");
    const id = await seedWebhookEvent({ personId, status: "processed" });

    const items = await listWebhookEvents();
    const match = items.find((i) => i.id === id);
    expect(match).toMatchObject({ personId, customerName: "Wanda Webhook", status: "processed" });
  });

  it("still returns an event with no matched customer, with null customer fields", async () => {
    const id = await seedWebhookEvent({ personId: null });

    const items = await listWebhookEvents();
    const match = items.find((i) => i.id === id);
    expect(match).toMatchObject({ personId: null, customerName: null });
  });

  it("filters by status", async () => {
    const failedId = await seedWebhookEvent({ status: "failed", errorMessage: "eventId: Required" });
    const processedId = await seedWebhookEvent({ status: "processed" });

    const failedItems = await listWebhookEvents({ status: "failed" });
    expect(failedItems.some((i) => i.id === failedId)).toBe(true);
    expect(failedItems.some((i) => i.id === processedId)).toBe(false);
    expect(failedItems.find((i) => i.id === failedId)?.errorMessage).toBe("eventId: Required");

    const allItems = await listWebhookEvents({ status: "all" });
    expect(allItems.some((i) => i.id === failedId)).toBe(true);
    expect(allItems.some((i) => i.id === processedId)).toBe(true);
  });

  it("filters by source", async () => {
    const refundId = await seedWebhookEvent({ source: "bask_payment_refunded" });
    const orderId = await seedWebhookEvent({ source: "bask_order" });

    const items = await listWebhookEvents({ source: "bask_payment_refunded" });
    expect(items.some((i) => i.id === refundId)).toBe(true);
    expect(items.some((i) => i.id === orderId)).toBe(false);
  });

  it("includes the raw payload", async () => {
    const id = await seedWebhookEvent({ rawPayload: { foo: "bar" } });
    const items = await listWebhookEvents();
    expect(items.find((i) => i.id === id)?.rawPayload).toEqual({ foo: "bar" });
  });
});
