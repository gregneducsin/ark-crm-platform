import { describe, expect, it } from "vitest";
import { db, customersTable, purchasesTable } from "@luma/db";
import { eq, sql } from "drizzle-orm";
import { customersSummaryQuerySchema } from "@luma/shared";
import { getDtcLeadCount } from "./dtc-lead-count.service.js";

describe("DTC lead counts", () => {
  it("counts all matching saved leads beyond a list page and includes date boundaries", async () => {
    const ids: string[] = [];
    try {
      for (const [type, date, count] of [["DTC", "2040-02-01", 11], ["DTC", "2040-02-02", 2], ["DTC", "2040-01-31", 1], ["SMS Inquiry", "2040-02-01", 1]] as const) {
        const rows = await db.insert(customersTable).values(Array.from({ length: count }, () => ({
          firstName: "Synthetic", lastName: "Count", email: crypto.randomUUID() + "@example.com", leadType: type, leadReceivedDate: date,
        }))).returning({ id: customersTable.id });
        ids.push(...rows.map(r => r.id));
      }
      const result = await getDtcLeadCount(customersSummaryQuerySchema.parse({ period: 1, dateFrom: "2040-02-01", dateTo: "2040-02-02" }));
      expect(result.total).toBe(13);
      expect(result.period).toBeNull();
      expect(result.unmatchedContactCount).toBeNull();
      expect((await getDtcLeadCount(customersSummaryQuerySchema.parse({ dateFrom: "2040-03-01", dateTo: "2040-03-02" }))).total).toBe(0);
    } finally { for (const id of ids) await db.delete(customersTable).where(eq(customersTable.id, id)); }
  });

  it("defaults to 30 days and supports all time", async () => {
    const before = await getDtcLeadCount(customersSummaryQuerySchema.parse({}));
    const allBefore = await getDtcLeadCount(customersSummaryQuerySchema.parse({ period: "all" }));
    const [row] = await db.insert(customersTable).values({
      firstName: "Synthetic", lastName: "Old", email: crypto.randomUUID() + "@example.com", leadType: "DTC",
      leadReceivedDate: sql`(current_date - 60)`,
    }).returning();
    try {
      expect((await getDtcLeadCount(customersSummaryQuerySchema.parse({}))).total).toBe(before.total);
      expect((await getDtcLeadCount(customersSummaryQuerySchema.parse({ period: "all" }))).total).toBe(allBefore.total + 1);
      expect(before.period).toBe(30);
    } finally { await db.delete(customersTable).where(eq(customersTable.id, row.id)); }
  });
});

describe("DTC conversion", () => {
  it("counts completed first orders once within the lead cohort, not the purchase period", async () => {
    const ids: string[] = [];
    try {
      for (let i = 0; i < 10; i++) {
        const [row] = await db.insert(customersTable).values({
          firstName: "Synthetic", lastName: "Conversion", email: crypto.randomUUID() + "@example.com",
          leadType: i === 8 ? "SMS Inquiry" : "DTC",
          leadReceivedDate: i === 9 ? "2042-01-31" : i === 1 ? "2042-02-02" : "2042-02-01",
        }).returning({ id: customersTable.id });
        ids.push(row.id);
      }
      const order = async (i: number, status: "completed" | "pending" | "payment_failed" | "refunded" | "cancelled", classification: "first_order" | "recurring" | "unknown") =>
        db.insert(purchasesTable).values({
          customerId: ids[i], purchaseDate: "2042-03-01", orderNumber: crypto.randomUUID(),
          productName: "Synthetic", amountPaid: "120.00", status, orderClassification: classification,
        });
      await order(0, "completed", "first_order");
      await expect(order(0, "completed", "first_order")).rejects.toThrow(); // Ark also prevents duplicate first-order classifications.
      await order(0, "completed", "recurring");
      await order(0, "completed", "recurring");
      await order(1, "completed", "first_order");
      await order(2, "pending", "first_order");
      await order(3, "payment_failed", "first_order");
      await order(4, "refunded", "first_order");
      await order(5, "cancelled", "first_order");
      await order(6, "completed", "recurring");
      await order(7, "completed", "unknown");
      await order(8, "completed", "first_order");
      await order(9, "completed", "first_order");
      const result = await getDtcLeadCount(customersSummaryQuerySchema.parse({ period: 1, dateFrom: "2042-02-01", dateTo: "2042-02-02" }));
      expect(result).toMatchObject({ total: 8, purchased: 2, notPurchased: 6, conversionRate: 25 });
      const empty = await getDtcLeadCount(customersSummaryQuerySchema.parse({ dateFrom: "2042-04-01", dateTo: "2042-04-02" }));
      expect(empty).toMatchObject({ total: 0, purchased: 0, notPurchased: 0, conversionRate: null });
    } finally {
      for (const id of ids) await db.delete(customersTable).where(eq(customersTable.id, id));
    }
  });
});
