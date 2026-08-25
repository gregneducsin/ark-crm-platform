import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";
import { isCustomerSmsDnd, setCustomerSmsDnd, isCustomerEmailDnd, setCustomerEmailDnd } from "./dnd.service.js";

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName: "Dnd", lastName: "Test", email: `dnd-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" })
    .returning({ id: customersTable.id });
  return row.id;
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
