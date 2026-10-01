import { describe, expect, it } from "vitest";
import { db, customersTable, unmatchedSmsThreadsTable, unmatchedSmsMessagesTable } from "@luma/db";
import { eq, sql } from "drizzle-orm";
import { customersSummaryQuerySchema } from "@luma/shared";
import { getIncompleteOnboardingCount } from "./incomplete-onboarding-count.service.js";

describe("incomplete onboarding counts", () => {
  it("uses the first inbound date, supports all-time and upper-only bounds, and excludes formatted saved phones", async () => {
    const query = customersSummaryQuerySchema.parse({});
    const before = await getIncompleteOnboardingCount(query);
    const allBefore = await getIncompleteOnboardingCount(customersSummaryQuerySchema.parse({ period: "all" }));
    const [thread] = await db.insert(unmatchedSmsThreadsTable).values({ fromPhone: "+19995550111" }).returning();
    await db.insert(unmatchedSmsMessagesTable).values([
      { threadId: thread.id, direction: "outbound", body: "Synthetic earlier outbound", createdAt: new Date("2000-01-01T00:00:00Z") },
      { threadId: thread.id, direction: "inbound", body: "Synthetic old inbound", createdAt: sql`current_timestamp - interval '60 days'` },
      { threadId: thread.id, direction: "inbound", body: "Synthetic recent inbound", createdAt: new Date() },
    ]);
    expect((await getIncompleteOnboardingCount(query)).total).toBe(before.total);
    expect((await getIncompleteOnboardingCount(customersSummaryQuerySchema.parse({ period: "all" }))).total).toBe(allBefore.total + 1);
    const upper = await getIncompleteOnboardingCount(customersSummaryQuerySchema.parse({ dateTo: before.dateFrom! }));
    expect(upper.dateFrom).toBeNull();
    expect(upper.period).toBeNull();
    expect(upper.total).toBeGreaterThan(0);
    await db.insert(customersTable).values({
      firstName: "Synthetic", lastName: "Existing", email: crypto.randomUUID() + "@example.com",
      phone: "+1 (999) 555-0111", leadReceivedDate: "2000-01-01",
    });
    expect((await getIncompleteOnboardingCount(customersSummaryQuerySchema.parse({ period: "all" }))).total).toBe(allBefore.total);
  });

  it("counts senders once, excludes saved and dismissed contacts, and filters first inbound date", async () => {
    const ids: string[] = [];
    let customerId: string | undefined;
    const phone = "+1999" + String(Math.floor(Math.random() * 10000000)).padStart(7, "0");
    try {
      const [customer] = await db.insert(customersTable).values({
        firstName: "Synthetic", lastName: "Saved", email: crypto.randomUUID() + "@example.com", phone, leadReceivedDate: "2043-02-01",
      }).returning();
      customerId = customer.id;
      for (let i = 0; i < 8; i++) {
        const [thread] = await db.insert(unmatchedSmsThreadsTable).values({
          fromPhone: i === 5 ? phone : "synthetic-" + crypto.randomUUID(),
          status: i === 3 ? "dismissed" : i === 1 ? "replied" : "needs_review",
          linkedCustomerId: i === 2 ? customer.id : null,
          aiIntent: i === 4 ? "spam_or_irrelevant" : null,
          onboardingHeld: i === 0,
        }).returning();
        ids.push(thread.id);
        if (i === 6) continue; // no inbound text is not a texter
        await db.insert(unmatchedSmsMessagesTable).values({
          threadId: thread.id, direction: "inbound", body: "Synthetic test",
          createdAt: new Date(i === 7 ? "2043-01-31T23:59:59Z" : i === 1 ? "2043-02-02T23:59:59Z" : "2043-02-01T00:00:00Z"),
        });
        await db.insert(unmatchedSmsMessagesTable).values({
          threadId: thread.id, direction: "inbound", body: "Synthetic second text",
          createdAt: new Date("2043-02-02T23:59:59Z"),
        });
      }
      const result = await getIncompleteOnboardingCount(customersSummaryQuerySchema.parse({
        period: 1, dateFrom: "2043-02-01", dateTo: "2043-02-02",
      }));
      expect(result).toMatchObject({ total: 2, needsReview: 1, held: 1, dateFrom: "2043-02-01", dateTo: "2043-02-02", period: null });
      await db.update(unmatchedSmsThreadsTable).set({ linkedCustomerId: customer.id }).where(eq(unmatchedSmsThreadsTable.id, ids[0]));
      expect((await getIncompleteOnboardingCount(customersSummaryQuerySchema.parse({ dateFrom: "2043-02-01", dateTo: "2043-02-02" }))).total).toBe(1);
      expect((await getIncompleteOnboardingCount(customersSummaryQuerySchema.parse({ dateFrom: "2043-03-01", dateTo: "2043-03-02" }))).total).toBe(0);
    } finally {
      for (const id of ids) await db.delete(unmatchedSmsThreadsTable).where(eq(unmatchedSmsThreadsTable.id, id));
      if (customerId) await db.delete(customersTable).where(eq(customersTable.id, customerId));
    }
  });
});
