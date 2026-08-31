import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, purchasesTable } from "@luma/db";
import { isCustomerSmsDnd, setCustomerSmsDnd, isCustomerEmailDnd, setCustomerEmailDnd, silenceOtherLeadsSharingPhone } from "./dnd.service.js";

async function seedCustomer(overrides: Partial<{ phone: string }> = {}): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName: "Dnd", lastName: "Test", email: `dnd-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15", ...overrides })
    .returning({ id: customersTable.id });
  return row.id;
}

function uniquePhone(): string {
  const digits = crypto.randomUUID().replace(/\D/g, "");
  return `+1555${(digits + "0000000").slice(0, 7)}`;
}

describe("SMS DND", () => {
  it("defaults to not do-not-disturb for a new customer", async () => {
    const personId = await seedCustomer();
    expect(await isCustomerSmsDnd(personId)).toBe(false);
  });

  it("setCustomerSmsDnd(true) sets dnd and stamps dndAt", async () => {
    const personId = await seedCustomer();
    await setCustomerSmsDnd(personId, true);

    expect(await isCustomerSmsDnd(personId)).toBe(true);
    const [row] = await db.select({ dnd: customersTable.dnd, dndAt: customersTable.dndAt }).from(customersTable).where(eq(customersTable.id, personId));
    expect(row.dnd).toBe(true);
    expect(row.dndAt).not.toBeNull();
  });

  it("setCustomerSmsDnd(false) clears dnd and dndAt", async () => {
    const personId = await seedCustomer();
    await setCustomerSmsDnd(personId, true);
    await setCustomerSmsDnd(personId, false);

    expect(await isCustomerSmsDnd(personId)).toBe(false);
    const [row] = await db.select({ dnd: customersTable.dnd, dndAt: customersTable.dndAt }).from(customersTable).where(eq(customersTable.id, personId));
    expect(row.dnd).toBe(false);
    expect(row.dndAt).toBeNull();
  });
});

describe("Email DND", () => {
  it("defaults to not do-not-disturb for a new customer", async () => {
    const personId = await seedCustomer();
    expect(await isCustomerEmailDnd(personId)).toBe(false);
  });

  it("setCustomerEmailDnd(true) sets emailDnd and stamps emailDndAt", async () => {
    const personId = await seedCustomer();
    await setCustomerEmailDnd(personId, true);

    expect(await isCustomerEmailDnd(personId)).toBe(true);
    const [row] = await db.select({ emailDnd: customersTable.emailDnd, emailDndAt: customersTable.emailDndAt }).from(customersTable).where(eq(customersTable.id, personId));
    expect(row.emailDnd).toBe(true);
    expect(row.emailDndAt).not.toBeNull();
  });

  it("setCustomerEmailDnd(false) clears emailDnd and emailDndAt", async () => {
    const personId = await seedCustomer();
    await setCustomerEmailDnd(personId, true);
    await setCustomerEmailDnd(personId, false);

    expect(await isCustomerEmailDnd(personId)).toBe(false);
    const [row] = await db.select({ emailDnd: customersTable.emailDnd, emailDndAt: customersTable.emailDndAt }).from(customersTable).where(eq(customersTable.id, personId));
    expect(row.emailDnd).toBe(false);
    expect(row.emailDndAt).toBeNull();
  });
});

describe("SMS and email DND are independent", () => {
  it("setting SMS DND does not set email DND", async () => {
    const personId = await seedCustomer();
    await setCustomerSmsDnd(personId, true);

    expect(await isCustomerSmsDnd(personId)).toBe(true);
    expect(await isCustomerEmailDnd(personId)).toBe(false);
  });

  it("setting email DND does not set SMS DND", async () => {
    const personId = await seedCustomer();
    await setCustomerEmailDnd(personId, true);

    expect(await isCustomerEmailDnd(personId)).toBe(true);
    expect(await isCustomerSmsDnd(personId)).toBe(false);
  });
});

describe("silenceOtherLeadsSharingPhone", () => {
  it("sets SMS and email DND on another unpurchased customer sharing the same phone", async () => {
    const phone = uniquePhone();
    const purchaserId = await seedCustomer({ phone });
    const staleLeadId = await seedCustomer({ phone });

    await silenceOtherLeadsSharingPhone(purchaserId);

    expect(await isCustomerSmsDnd(staleLeadId)).toBe(true);
    expect(await isCustomerEmailDnd(staleLeadId)).toBe(true);
    const [row] = await db.select({ dndAt: customersTable.dndAt, emailDndAt: customersTable.emailDndAt }).from(customersTable).where(eq(customersTable.id, staleLeadId));
    expect(row.dndAt).not.toBeNull();
    expect(row.emailDndAt).not.toBeNull();
  });

  it("does not touch the purchasing customer's own DND state", async () => {
    const phone = uniquePhone();
    const purchaserId = await seedCustomer({ phone });
    await seedCustomer({ phone });

    await silenceOtherLeadsSharingPhone(purchaserId);

    expect(await isCustomerSmsDnd(purchaserId)).toBe(false);
    expect(await isCustomerEmailDnd(purchaserId)).toBe(false);
  });

  it("does not silence a sibling that already has its own completed purchase", async () => {
    const phone = uniquePhone();
    const purchaserId = await seedCustomer({ phone });
    const otherRealCustomerId = await seedCustomer({ phone });
    await db.insert(purchasesTable).values({
      customerId: otherRealCustomerId,
      purchaseDate: "2026-08-20",
      orderNumber: crypto.randomUUID(),
      productName: "Test",
      amountPaid: "50.00",
      status: "completed",
    });

    await silenceOtherLeadsSharingPhone(purchaserId);

    expect(await isCustomerSmsDnd(otherRealCustomerId)).toBe(false);
    expect(await isCustomerEmailDnd(otherRealCustomerId)).toBe(false);
  });

  it("does not affect a customer with a different phone number", async () => {
    const purchaserId = await seedCustomer({ phone: uniquePhone() });
    const unrelatedId = await seedCustomer({ phone: uniquePhone() });

    await silenceOtherLeadsSharingPhone(purchaserId);

    expect(await isCustomerSmsDnd(unrelatedId)).toBe(false);
    expect(await isCustomerEmailDnd(unrelatedId)).toBe(false);
  });

  it("is a no-op when the purchasing customer has no usable phone number", async () => {
    const purchaserId = await seedCustomer({ phone: undefined });
    await expect(silenceOtherLeadsSharingPhone(purchaserId)).resolves.toBeUndefined();
  });
});
