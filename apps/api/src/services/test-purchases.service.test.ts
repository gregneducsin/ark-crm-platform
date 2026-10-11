import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, purchasesTable, externalIdentitiesTable, marketingSpendWeeksTable, purchaseClassificationAuditsTable } from "@luma/db";
import { updatePurchase, getPurchasesSummary } from "./purchases.service.js";
import { listMarketingCpaWeeks } from "./marketing-spend.service.js";
import { updatePurchaseRequestSchema } from "@luma/shared";

describe("test purchase classification", () => {
  it("preserves the purchase and audit history while excluding it from CPA and order totals, and is reversible", async () => {
    const id = crypto.randomUUID();
    const [customer] = await db.insert(customersTable).values({
      firstName: "Synthetic", lastName: "Fixture", email: id + "@example.com", leadReceivedDate: "1980-01-04",
    }).returning();
    await db.insert(externalIdentitiesTable).values({ personId: customer.id, system: "bask", externalId: id });
    const [week] = await db.insert(marketingSpendWeeksTable).values({
      weekStart: "1980-01-04", weekEnd: "1980-01-10", ecommerceSpend: "600.00", createdBy: "test@example.com", updatedBy: "test@example.com",
    }).returning();
    const [purchase] = await db.insert(purchasesTable).values({
      customerId: customer.id, purchaseDate: "1980-01-04", orderNumber: id, productName: "Synthetic product",
      amountPaid: "100.00", status: "completed", orderClassification: "first_order", orderClassificationSource: "bask",
    }).returning();
    const metric = async () => (await listMarketingCpaWeeks()).find(w => w.id === week.id)!.ecommerce;
    expect(await metric()).toMatchObject({ closedDeals: 1, acquisitionRevenue: "100.00", cpa: 600 });
    const before = await getPurchasesSummary({ dateFrom: "1980-01-04", dateTo: "1980-01-10" });
    const actor = { id: crypto.randomUUID(), email: "test@example.com" };
    const input = updatePurchaseRequestSchema.parse({ orderClassification: "test" });
    await updatePurchase(purchase.id, input, actor);
    const [saved] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, purchase.id));
    expect(saved).toMatchObject({ status: "completed", amountPaid: "100.00", orderClassification: "test", orderClassificationSource: "manual" });
    expect(await metric()).toMatchObject({ closedDeals: 0, acquisitionRevenue: "0", recurringExclusions: 0, cpa: null });
    const after = await getPurchasesSummary({ dateFrom: "1980-01-04", dateTo: "1980-01-10" });
    expect(before.totalCompletedOrders - after.totalCompletedOrders).toBe(1);
    expect(Number(before.totalRevenue) - Number(after.totalRevenue)).toBe(100);
    const audits = await db.select().from(purchaseClassificationAuditsTable).where(eq(purchaseClassificationAuditsTable.purchaseId, purchase.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ previousClassification: "first_order", newClassification: "test", changedBy: actor.email });
    await updatePurchase(purchase.id, { orderClassification: "first_order" }, actor);
    expect(await metric()).toMatchObject({ closedDeals: 1, cpa: 600 });
  });
});
