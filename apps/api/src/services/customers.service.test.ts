import { describe, expect, it } from "vitest";
import { db, customersTable } from "@luma/db";
import { getCustomersSummary } from "./customers.service.js";

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
