import { describe, expect, it } from "vitest";
import { db, customersTable, purchasesTable } from "@luma/db";
import { listPurchases, createPurchase } from "./purchases.service.js";
import { isCustomerSmsDnd, isCustomerEmailDnd } from "./dnd.service.js";

async function seedCustomer(overrides: Partial<{ phone: string }> = {}): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "Order",
      lastName: "Test",
      email: `order-test-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-16",
      ...overrides,
    })
    .returning({ id: customersTable.id });
  return row.id;
}

function uniquePhone(): string {
  const digits = crypto.randomUUID().replace(/\D/g, "");
  return `+1555${(digits + "0000000").slice(0, 7)}`;
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

describe("createPurchase", () => {
  it("silences (SMS + email DND) any other unpurchased lead sharing the purchaser's phone number", async () => {
    const phone = uniquePhone();
    const purchaserId = await seedCustomer({ phone });
    const staleLeadId = await seedCustomer({ phone });

    await createPurchase(purchaserId, {
      purchaseDate: "2026-08-31",
      orderNumber: `ORD-${crypto.randomUUID()}`,
      productName: "Test Product",
      amountPaid: "1.00",
    });

    expect(await isCustomerSmsDnd(staleLeadId)).toBe(true);
    expect(await isCustomerEmailDnd(staleLeadId)).toBe(true);
    expect(await isCustomerSmsDnd(purchaserId)).toBe(false);
    expect(await isCustomerEmailDnd(purchaserId)).toBe(false);
  });
});
