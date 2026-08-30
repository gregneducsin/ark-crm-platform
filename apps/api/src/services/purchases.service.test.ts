import { describe, expect, it } from "vitest";
import { db, customersTable, purchasesTable } from "@luma/db";
import { listPurchases } from "./purchases.service.js";

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "Order",
      lastName: "Test",
      email: `order-test-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-16",
    })
    .returning({ id: customersTable.id });
  return row.id;
}

async function seedPurchase(customerId: string, purchaseDate: string, orderNumber: string): Promise<number> {
  const [row] = await db
    .insert(purchasesTable)
    .values({ customerId, purchaseDate, orderNumber, productName: "Test Product", amountPaid: "100.00", status: "completed" })
    .returning({ id: purchasesTable.id });
  return row.id;
}

describe("listPurchases", () => {
  it("breaks a same-day purchaseDate tie by actual creation order, not by random id", async () => {
    const customerId = await seedCustomer();
    // All three share the same purchaseDate (a bare date, no time), so a
    // tiebreak on id alone would order them randomly rather than by when the
    // order actually arrived — this made a brand-new order appear to vanish
    // instead of showing at the top of the default (desc) Orders page sort.
    const first = await seedPurchase(customerId, "2026-06-01", `TIE-FIRST-${crypto.randomUUID()}`);
    const second = await seedPurchase(customerId, "2026-06-01", `TIE-SECOND-${crypto.randomUUID()}`);
    const third = await seedPurchase(customerId, "2026-06-01", `TIE-THIRD-${crypto.randomUUID()}`);

    const desc = await listPurchases({ sortBy: "purchaseDate", sortDir: "desc", limit: 100, offset: 0 });
    const descIds = desc.purchases.filter((p) => [first, second, third].includes(p.id)).map((p) => p.id);
    expect(descIds).toEqual([third, second, first]);

    const asc = await listPurchases({ sortBy: "purchaseDate", sortDir: "asc", limit: 100, offset: 0 });
    const ascIds = asc.purchases.filter((p) => [first, second, third].includes(p.id)).map((p) => p.id);
    expect(ascIds).toEqual([first, second, third]);
  });
});
