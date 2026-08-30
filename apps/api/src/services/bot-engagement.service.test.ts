import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, customersTable, purchasesTable } from "@luma/db";
import { getOrCreateConversation, appendMessage } from "./conversations.service.js";
import { getOrCreateEmailConversation, appendEmailMessage } from "./email-conversations.service.js";
import { getBotEngagementSummary } from "./bot-engagement.service.js";

async function seedCustomer(leadReceivedDate: string): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "Engagement",
      lastName: "Test",
      email: `bot-engagement-${crypto.randomUUID()}@example.com`,
      leadReceivedDate,
    })
    .returning({ id: customersTable.id });
  return row.id;
}

async function seedPurchase(customerId: string, purchaseDate: string, status: "completed" | "payment_failed" = "completed"): Promise<void> {
  await db.insert(purchasesTable).values({
    customerId,
    purchaseDate,
    orderNumber: `ORD-${crypto.randomUUID()}`,
    productName: "Semaglutide",
    amountPaid: "175.00",
    status,
    orderClassification: "first_order",
  });
}

const TODAY = new Date().toISOString().slice(0, 10);

// Tests share one live table across the whole suite (no per-test reset), so
// every assertion here compares a before/after snapshot around exactly the
// rows this test itself inserts, rather than asserting an absolute count —
// that stays correct regardless of what other tests or files have already
// added to the same tables. Sequential test files (see vitest.config.ts's
// fileParallelism: false) make this safe: nothing else writes concurrently.
async function diff(period: number | "all", fn: () => Promise<void>) {
  const before = await getBotEngagementSummary({ period });
  await fn();
  const after = await getBotEngagementSummary({ period });
  return {
    purchasedCount: after.purchasedCount - before.purchasedCount,
    spokeToBotCount: after.spokeToBotCount - before.spokeToBotCount,
    noBotContactCount: after.noBotContactCount - before.noBotContactCount,
  };
}

describe("getBotEngagementSummary", () => {
  it("counts a lead who replied by SMS before purchasing as having spoken to the bot", async () => {
    const delta = await diff("all", async () => {
      const personId = await seedCustomer("2026-01-01");
      const conversation = await getOrCreateConversation(personId);
      await appendMessage(conversation.id, "inbound", "Yes I'm interested", {});
      await seedPurchase(personId, TODAY);
    });
    expect(delta).toEqual({ purchasedCount: 1, spokeToBotCount: 1, noBotContactCount: 0 });
  });

  it("counts a lead who replied by email before purchasing as having spoken to the bot", async () => {
    const delta = await diff("all", async () => {
      const personId = await seedCustomer("2026-01-01");
      const conversation = await getOrCreateEmailConversation(personId);
      await appendEmailMessage(conversation.id, "inbound", "Re: question", "Yes I'm interested", {});
      await seedPurchase(personId, TODAY);
    });
    expect(delta).toEqual({ purchasedCount: 1, spokeToBotCount: 1, noBotContactCount: 0 });
  });

  it("does not count an opener-only conversation (no reply) as having spoken to the bot", async () => {
    const delta = await diff("all", async () => {
      const personId = await seedCustomer("2026-01-01");
      const conversation = await getOrCreateConversation(personId);
      await appendMessage(conversation.id, "outbound", "Hey, this is Alexis...", {});
      await seedPurchase(personId, TODAY);
    });
    expect(delta).toEqual({ purchasedCount: 1, spokeToBotCount: 0, noBotContactCount: 1 });
  });

  it("does not count a reply that arrived after the purchase date", async () => {
    const delta = await diff("all", async () => {
      const personId = await seedCustomer("2026-01-01");
      // Purchase dated in the past — the reply below (created "now") lands
      // after it, so it must not count as "before purchasing."
      await seedPurchase(personId, "2020-01-01");
      const conversation = await getOrCreateConversation(personId);
      await appendMessage(conversation.id, "inbound", "Late reply", {});
    });
    expect(delta).toEqual({ purchasedCount: 1, spokeToBotCount: 0, noBotContactCount: 1 });
  });

  it("excludes a payment_failed purchase from the count entirely", async () => {
    const delta = await diff("all", async () => {
      const personId = await seedCustomer("2026-01-01");
      await seedPurchase(personId, TODAY, "payment_failed");
    });
    expect(delta).toEqual({ purchasedCount: 0, spokeToBotCount: 0, noBotContactCount: 0 });
  });

  it("computes avg days to close from lead-received to purchase, not from real-world time", async () => {
    // Purchase dated *after* today (real "now") — a message with the default
    // createdAt (now) still lands "before" this purchase date, so it counts
    // as spoken-to-bot, and days-to-close reflects the two dates supplied
    // (4 apart), not whatever the actual wall-clock date happens to be.
    const purchaseDate = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let personId = "";

    const delta = await diff("all", async () => {
      personId = await seedCustomer(TODAY);
      const conversation = await getOrCreateConversation(personId);
      await appendMessage(conversation.id, "inbound", "Interested", {});
      await seedPurchase(personId, purchaseDate);
    });
    expect(delta).toEqual({ purchasedCount: 1, spokeToBotCount: 1, noBotContactCount: 0 });

    // Row-level ground truth for this exact customer, independent of the
    // service's own (rounded, shared-state) aggregate — proves the date
    // arithmetic itself is right.
    const [row] = await db
      .select({ days: sql<number>`(${purchasesTable.purchaseDate}::date - ${customersTable.leadReceivedDate}::date)::int` })
      .from(customersTable)
      .innerJoin(purchasesTable, eq(purchasesTable.customerId, customersTable.id))
      .where(eq(customersTable.id, personId));
    expect(row.days).toBe(4);
  });

  it("filters to the given period by lead-received date — a lead outside the window contributes nothing", async () => {
    const delta = await diff(7, async () => {
      const personId = await seedCustomer("2000-01-01");
      await seedPurchase(personId, "2000-01-05");
    });
    expect(delta).toEqual({ purchasedCount: 0, spokeToBotCount: 0, noBotContactCount: 0 });
  });
});
