import { describe, expect, it } from "vitest";
import { db, customersTable } from "@luma/db";
import { getCustomersSummary, listCustomers } from "./customers.service.js";

async function seedCustomer(leadReceivedDate: string): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "Summary",
      lastName: "Test",
      email: `customers-summary-${crypto.randomUUID()}@example.com`,
      leadReceivedDate,
    })
    .returning({ id: customersTable.id });
  return row.id;
}

// Tests share one live table across the whole suite (no per-test reset), so
// every assertion compares a before/after snapshot around exactly the rows
// this test itself inserts — same reasoning as bot-engagement.service.test.ts.
describe("getCustomersSummary", () => {
  it("filters by an exact dateFrom/dateTo range instead of a trailing-day period", async () => {
    const before = await getCustomersSummary({ dateFrom: "2000-03-01", dateTo: "2000-03-31" });

    await seedCustomer("2000-03-15");
    // Outside the range — should not affect the count.
    await seedCustomer("2000-01-01");

    const after = await getCustomersSummary({ dateFrom: "2000-03-01", dateTo: "2000-03-31" });
    expect(after.totalLeads - before.totalLeads).toBe(1);
  });

  it("still defaults to a 30-day trailing period when neither period nor a date range is given", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const before = await getCustomersSummary({});
    await seedCustomer(today);
    const after = await getCustomersSummary({});
    expect(after.totalLeads - before.totalLeads).toBe(1);
  });
});

describe("listCustomers phone search", () => {
  it("finds a customer by digits even when their phone was stored with punctuation", async () => {
    const tail = String(5000000 + Math.floor(Math.random() * 900000));
    const [row] = await db
      .insert(customersTable)
      .values({ firstName: "Phone", lastName: "Search", email: `phone-search-${crypto.randomUUID()}@example.com`, phone: `(555) ${tail.slice(0, 3)}-${tail.slice(3)}`, leadReceivedDate: "2026-08-15" })
      .returning({ id: customersTable.id });

    const result = await listCustomers({ search: `555${tail}`, limit: 25, offset: 0, sortBy: "leadReceivedDate", sortDir: "desc" } as Parameters<typeof listCustomers>[0]);
    expect(result.customers.some((c: { id: string }) => c.id === row.id)).toBe(true);
  });
});

