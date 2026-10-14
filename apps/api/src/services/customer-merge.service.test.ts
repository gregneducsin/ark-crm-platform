import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db, customersTable, customerNotesTable, purchasesTable, externalIdentitiesTable, questionnaireEventsTable,
  conversationsTable, conversationMessagesTable, supportConversationsTable, supportConversationMessagesTable,
  emailConversationsTable, emailConversationMessagesTable, leadCheckinTriggersTable, abandonedCartTriggersTable,
} from "@luma/db";
import { namesCompatible } from "../lib/customer-name-match.js";
import { mergeCustomersTx, MergeRefusedError, mergeDuplicateCustomersByPhone, reconcileDuplicateByPhone, findDuplicateCandidates, mergeCustomersByStaff } from "./customer-merge.service.js";

let phoneCounter = 0;
const uniquePhone = () => `+1555${String(3000000 + ++phoneCounter).padStart(7, "0")}`;

interface SeedOpts {
  firstName?: string; lastName?: string; email?: string; phone?: string | null;
  createdAt?: Date; leadType?: string; dnd?: boolean; emailDnd?: boolean;
}
async function seedCustomer(opts: SeedOpts = {}) {
  const [row] = await db.insert(customersTable).values({
    firstName: opts.firstName ?? "Bertha", lastName: opts.lastName ?? "Guerra",
    email: opts.email ?? `${crypto.randomUUID()}@example.com`,
    phone: opts.phone === undefined ? null : opts.phone,
    leadReceivedDate: "2026-09-17", leadType: opts.leadType ?? "Bask abandoned cart",
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    ...(opts.dnd !== undefined ? { dnd: opts.dnd } : {}), ...(opts.emailDnd !== undefined ? { emailDnd: opts.emailDnd } : {}),
  }).returning();
  return row;
}
async function purchase(customerId: string, orderNumber = crypto.randomUUID()) {
  await db.insert(purchasesTable).values({
    customerId, purchaseDate: "2026-10-14", orderNumber, productName: "Semaglutide", amountPaid: "450.00",
    status: "completed", orderClassification: "first_order", orderClassificationSource: "bask",
  });
}
async function questionnaire(personId: string, questionnaireId: string, status: string, lastEventAt = new Date()) {
  const [row] = await db.insert(questionnaireEventsTable).values({ personId, questionnaireId, status, lastEventAt }).returning();
  return row;
}
async function exists(id: string) {
  const [row] = await db.select({ id: customersTable.id }).from(customersTable).where(eq(customersTable.id, id));
  return Boolean(row);
}
const merge = (survivor: string, duplicate: string) => db.transaction((tx) => mergeCustomersTx(tx, survivor, duplicate));

describe("namesCompatible", () => {
  it("ignores case, spacing and punctuation", () => {
    expect(namesCompatible({ firstName: "Bertha", lastName: "Guerra" }, { firstName: " bertha ", lastName: "GUERRA" })).toBe(true);
  });
  it("treats the Unknown placeholder as matching anything", () => {
    expect(namesCompatible({ firstName: "Unknown", lastName: "Unknown" }, { firstName: "Bertha", lastName: "Guerra" })).toBe(true);
    expect(namesCompatible({ firstName: "Unknown", lastName: "Guerra" }, { firstName: "Bertha", lastName: "Guerra" })).toBe(true);
  });
  it("does not match different people, such as a family sharing a number", () => {
    expect(namesCompatible({ firstName: "Bertha", lastName: "Guerra" }, { firstName: "Carlos", lastName: "Guerra" })).toBe(false);
    expect(namesCompatible({ firstName: "Bertha", lastName: "Guerra" }, { firstName: "Bertha", lastName: "Lopez" })).toBe(false);
  });
});

describe("mergeCustomersTx", () => {
  it("moves everything off the newer record that bought and keeps the older record's history", async () => {
    const phone = uniquePhone();
    const older = await seedCustomer({ email: "aleceg0926@gmail.com", phone, createdAt: new Date("2026-09-17T12:00:00Z"), dnd: true, emailDnd: true });
    const newer = await seedCustomer({ email: "Aliceg0926@gmail.com", phone, leadType: "Bask questionnaire started", createdAt: new Date("2026-10-14T12:00:00Z") });

    // Older: abandoned cart on questionnaire 9562 with an SMS thread.
    const oldEvent = await questionnaire(older.id, "9562", "abandoned");
    await db.insert(abandonedCartTriggersTable).values({ personId: older.id, questionnaireEventId: oldEvent.id, dueAt: new Date() });
    await db.insert(externalIdentitiesTable).values({ personId: older.id, system: "bask", externalId: `old-${crypto.randomUUID()}` });
    const [oldConvo] = await db.insert(conversationsTable).values({ personId: older.id, promoOffered: true }).returning();
    await db.insert(conversationMessagesTable).values({ conversationId: oldConvo.id, direction: "outbound", body: "older opener" });
    await db.insert(leadCheckinTriggersTable).values({ personId: older.id, dueAt: new Date() });

    // Newer: started questionnaire 12261, purchased, with SMS, support and email threads.
    await questionnaire(newer.id, "12261", "started");
    const newIdentity = `new-${crypto.randomUUID()}`;
    await db.insert(externalIdentitiesTable).values({ personId: newer.id, system: "bask", externalId: newIdentity });
    await purchase(newer.id);
    const [newConvo] = await db.insert(conversationsTable).values({ personId: newer.id, needsAttention: true, needsAttentionReason: "newer review" }).returning();
    await db.insert(conversationMessagesTable).values({ conversationId: newConvo.id, direction: "inbound", body: "newer text" });
    const [newSupport] = await db.insert(supportConversationsTable).values({ personId: newer.id, orderShipped: true, trackingNumber: "TRACK123" }).returning();
    await db.insert(supportConversationMessagesTable).values({ conversationId: newSupport.id, direction: "outbound", body: "your order" });
    const [newEmail] = await db.insert(emailConversationsTable).values({ personId: newer.id }).returning();
    await db.insert(emailConversationMessagesTable).values({ conversationId: newEmail.id, direction: "outbound", subject: "Order", body: "email body" });
    await db.insert(leadCheckinTriggersTable).values({ personId: newer.id, dueAt: new Date() });

    const summary = await merge(older.id, newer.id);
    expect(summary).toMatchObject({ survivorId: older.id, duplicateId: newer.id, purchasesMoved: 1 });

    // The duplicate is gone; the survivor holds everything.
    expect(await exists(newer.id)).toBe(false);
    const [survivor] = await db.select().from(customersTable).where(eq(customersTable.id, older.id));
    expect(survivor.leadType).toBe("Bask abandoned cart");
    expect(survivor.createdAt.toISOString()).toBe("2026-09-17T12:00:00.000Z");
    // The address used to buy becomes the contact email, and the purchase's consent replaces the earlier opt-out.
    expect(survivor.email).toBe("Aliceg0926@gmail.com");
    expect(survivor.dnd).toBe(false);
    expect(survivor.emailDnd).toBe(false);

    expect(await db.select().from(purchasesTable).where(eq(purchasesTable.customerId, older.id))).toHaveLength(1);
    const events = await db.select().from(questionnaireEventsTable).where(eq(questionnaireEventsTable.personId, older.id));
    expect(events.map((e) => e.questionnaireId).sort()).toEqual(["12261", "9562"]);
    expect(await db.select().from(abandonedCartTriggersTable).where(eq(abandonedCartTriggersTable.personId, older.id))).toHaveLength(1);

    // Both Bask IDs now resolve to the survivor, so first-touch attribution stays with the older record.
    const identities = await db.select().from(externalIdentitiesTable).where(eq(externalIdentitiesTable.personId, older.id));
    expect(identities).toHaveLength(2);
    expect(identities.some((i) => i.externalId === newIdentity)).toBe(true);

    // SMS thread: one conversation, both sides' messages, flags combined.
    const convos = await db.select().from(conversationsTable).where(eq(conversationsTable.personId, older.id));
    expect(convos).toHaveLength(1);
    expect(convos[0].promoOffered).toBe(true);
    expect(convos[0].needsAttention).toBe(true);
    expect(convos[0].needsAttentionReason).toBe("newer review");
    const bodies = (await db.select().from(conversationMessagesTable).where(eq(conversationMessagesTable.conversationId, convos[0].id))).map((m) => m.body).sort();
    expect(bodies).toEqual(["newer text", "older opener"]);

    // Support and email threads moved across, since the survivor had none.
    const [support] = await db.select().from(supportConversationsTable).where(eq(supportConversationsTable.personId, older.id));
    expect(support).toMatchObject({ orderShipped: true, trackingNumber: "TRACK123" });
    expect(await db.select().from(supportConversationMessagesTable).where(eq(supportConversationMessagesTable.conversationId, support.id))).toHaveLength(1);
    const [email] = await db.select().from(emailConversationsTable).where(eq(emailConversationsTable.personId, older.id));
    expect(await db.select().from(emailConversationMessagesTable).where(eq(emailConversationMessagesTable.conversationId, email.id))).toHaveLength(1);

    // One scheduled check-in, not two.
    expect(await db.select().from(leadCheckinTriggersTable).where(eq(leadCheckinTriggersTable.personId, older.id))).toHaveLength(1);

    // A note explains what happened.
    const [note] = await db.select().from(customerNotesTable).where(eq(customerNotesTable.customerId, older.id));
    expect(note.body).toContain(newer.personNumber);
    expect(note.body).toContain("Aliceg0926@gmail.com");
    // The address that was replaced is not lost: the note says what it was.
    expect(note.body).toContain("changed from aleceg0926@gmail.com");
  });

  it("takes the newer state when both records saw the same questionnaire", async () => {
    const phone = uniquePhone();
    const older = await seedCustomer({ phone, createdAt: new Date("2026-09-01T00:00:00Z") });
    const newer = await seedCustomer({ phone, createdAt: new Date("2026-10-01T00:00:00Z") });
    await questionnaire(older.id, "Q-SHARED", "started", new Date("2026-09-01T00:00:00Z"));
    await questionnaire(newer.id, "Q-SHARED", "submitted", new Date("2026-10-01T00:00:00Z"));
    await merge(older.id, newer.id);
    const events = await db.select().from(questionnaireEventsTable).where(eq(questionnaireEventsTable.personId, older.id));
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("submitted");
  });

  it("refuses to merge two records that have both bought, changing nothing", async () => {
    const phone = uniquePhone();
    const a = await seedCustomer({ phone }); const b = await seedCustomer({ phone });
    await purchase(a.id); await purchase(b.id);
    await expect(merge(a.id, b.id)).rejects.toBeInstanceOf(MergeRefusedError);
    expect(await exists(a.id)).toBe(true);
    expect(await exists(b.id)).toBe(true);
  });

  it("uses the email on the notice that triggered the merge when neither record has bought yet", async () => {
    const phone = uniquePhone();
    const older = await seedCustomer({ phone, email: "typo-address@example.com", createdAt: new Date("2026-09-01T00:00:00Z") });
    const newer = await seedCustomer({ phone, email: "right-address@example.com", createdAt: new Date("2026-10-01T00:00:00Z") });
    await db.transaction((tx) => mergeCustomersTx(tx, older.id, newer.id, { preferredEmail: "RIGHT-address@example.com" }));
    const [row] = await db.select().from(customersTable).where(eq(customersTable.id, older.id));
    expect(row.email).toBe("right-address@example.com");
  });

  it("leaves the survivor's email alone when the notice's address is on neither record", async () => {
    const phone = uniquePhone();
    const older = await seedCustomer({ phone, email: "keep@example.com", createdAt: new Date("2026-09-01T00:00:00Z") });
    const newer = await seedCustomer({ phone, email: "other@example.com", createdAt: new Date("2026-10-01T00:00:00Z") });
    await db.transaction((tx) => mergeCustomersTx(tx, older.id, newer.id, { preferredEmail: "stranger@example.com" }));
    const [row] = await db.select().from(customersTable).where(eq(customersTable.id, older.id));
    expect(row.email).toBe("keep@example.com");
  });

  it("keeps an opt-out when neither record bought", async () => {
    const phone = uniquePhone();
    const a = await seedCustomer({ phone, dnd: true, createdAt: new Date("2026-09-01T00:00:00Z") });
    const b = await seedCustomer({ phone, createdAt: new Date("2026-10-01T00:00:00Z") });
    await merge(a.id, b.id);
    const [row] = await db.select().from(customersTable).where(eq(customersTable.id, a.id));
    expect(row.dnd).toBe(true);
  });
});

describe("reconcileDuplicateByPhone", () => {
  it("merges the newer record into the older one when exactly one other record shares the phone and the name matches", async () => {
    const phone = uniquePhone();
    const older = await seedCustomer({ phone, createdAt: new Date("2026-09-01T00:00:00Z") });
    const newer = await seedCustomer({ phone, createdAt: new Date("2026-10-01T00:00:00Z") });
    expect(await db.transaction((tx) => reconcileDuplicateByPhone(tx, newer.id))).toBe(older.id);
    expect(await exists(newer.id)).toBe(false);
  });

  it("matches phones stored in different formats", async () => {
    const digits = `555${String(4000000 + ++phoneCounter)}`;
    const older = await seedCustomer({ phone: `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`, createdAt: new Date("2026-09-01T00:00:00Z") });
    const newer = await seedCustomer({ phone: `+1${digits}`, createdAt: new Date("2026-10-01T00:00:00Z") });
    expect(await db.transaction((tx) => reconcileDuplicateByPhone(tx, newer.id))).toBe(older.id);
  });

  it("does not merge a family that shares one phone number", async () => {
    const phone = uniquePhone();
    const a = await seedCustomer({ phone, firstName: "Bertha", lastName: "Guerra" });
    const b = await seedCustomer({ phone, firstName: "Carlos", lastName: "Guerra" });
    expect(await db.transaction((tx) => reconcileDuplicateByPhone(tx, b.id))).toBe(b.id);
    expect(await exists(a.id)).toBe(true);
  });

  it("does not guess when more than two records share the number", async () => {
    const phone = uniquePhone();
    const a = await seedCustomer({ phone }); const b = await seedCustomer({ phone }); const c = await seedCustomer({ phone });
    expect(await db.transaction((tx) => reconcileDuplicateByPhone(tx, c.id))).toBe(c.id);
    for (const row of [a, b, c]) expect(await exists(row.id)).toBe(true);
  });

  it("does nothing for a record with no phone, and leaves both records when both have bought", async () => {
    const noPhone = await seedCustomer({ phone: null });
    expect(await db.transaction((tx) => reconcileDuplicateByPhone(tx, noPhone.id))).toBe(noPhone.id);
    const phone = uniquePhone();
    const a = await seedCustomer({ phone }); const b = await seedCustomer({ phone });
    await purchase(a.id); await purchase(b.id);
    expect(await db.transaction((tx) => reconcileDuplicateByPhone(tx, b.id))).toBe(b.id);
    expect(await exists(a.id)).toBe(true);
  });
});

describe("mergeDuplicateCustomersByPhone", () => {
  it("still reaches a real duplicate when many families sharing a phone number are also in the table", async () => {
    // 250 pairs that share a number but are different people (not mergeable): they must not crowd out the real one.
    for (let i = 0; i < 250; i++) {
      const familyPhone = uniquePhone();
      await seedCustomer({ phone: familyPhone, firstName: `Parent${i}`, lastName: "Crowd" });
      await seedCustomer({ phone: familyPhone, firstName: `Child${i}`, lastName: "Crowd" });
    }
    const phone = uniquePhone();
    const older = await seedCustomer({ phone, firstName: "Bertha", lastName: "Guerra", createdAt: new Date("2026-09-17T00:00:00Z") });
    const newer = await seedCustomer({ phone, firstName: "Bertha", lastName: "Guerra", createdAt: new Date("2026-10-14T00:00:00Z") });

    const result = await mergeDuplicateCustomersByPhone();
    expect(result.pairsExamined).toBeGreaterThanOrEqual(251);
    expect(result.merged.some((m) => m.survivorId === older.id && m.duplicateId === newer.id)).toBe(true);
    expect(await exists(newer.id)).toBe(false);
  });

  it("merges existing same-name, same-phone pairs and reports them by person number", async () => {
    const phone = uniquePhone();
    const older = await seedCustomer({ phone, createdAt: new Date("2026-09-01T00:00:00Z") });
    const newer = await seedCustomer({ phone, createdAt: new Date("2026-10-01T00:00:00Z") });
    const familyPhone = uniquePhone();
    const mom = await seedCustomer({ phone: familyPhone, firstName: "Bertha" });
    const son = await seedCustomer({ phone: familyPhone, firstName: "Carlos" });

    const result = await mergeDuplicateCustomersByPhone(500);
    const mine = result.merged.filter((m) => m.survivorId === older.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ duplicateId: newer.id, duplicatePersonNumber: newer.personNumber, survivorPersonNumber: older.personNumber });
    expect(await exists(newer.id)).toBe(false);
    expect(await exists(mom.id)).toBe(true);
    expect(await exists(son.id)).toBe(true);
  });
});

describe("a third record on the same phone number", () => {
  it("does not stop two matching records from merging when the other one is a different person", async () => {
    const phone = uniquePhone();
    const older = await seedCustomer({ phone, firstName: "Bertha", lastName: "Guerra", createdAt: new Date("2026-09-17T00:00:00Z") });
    const newer = await seedCustomer({ phone, firstName: "Bertha", lastName: "Guerra", createdAt: new Date("2026-10-14T00:00:00Z") });
    const relative = await seedCustomer({ phone, firstName: "Alice", lastName: "Guerra", createdAt: new Date("2026-08-01T00:00:00Z") });

    // Webhook-time check.
    expect(await db.transaction((tx) => reconcileDuplicateByPhone(tx, newer.id))).toBe(older.id);
    expect(await exists(newer.id)).toBe(false);
    expect(await exists(relative.id)).toBe(true);
  });

  it("is merged by the hourly sweep too", async () => {
    const phone = uniquePhone();
    const older = await seedCustomer({ phone, firstName: "Dora", lastName: "Mena", createdAt: new Date("2026-09-17T00:00:00Z") });
    const newer = await seedCustomer({ phone, firstName: "Dora", lastName: "Mena", createdAt: new Date("2026-10-14T00:00:00Z") });
    const relative = await seedCustomer({ phone, firstName: "Luis", lastName: "Mena" });
    const result = await mergeDuplicateCustomersByPhone(500);
    expect(result.merged.some((m) => m.survivorId === older.id && m.duplicateId === newer.id)).toBe(true);
    expect(await exists(relative.id)).toBe(true);
  });

  it("still does not guess when two different records could both be the same person", async () => {
    const phone = uniquePhone();
    const a = await seedCustomer({ phone, firstName: "Eva", lastName: "Soto" });
    const b = await seedCustomer({ phone, firstName: "Eva", lastName: "Soto" });
    const c = await seedCustomer({ phone, firstName: "Eva", lastName: "Soto" });
    expect(await db.transaction((tx) => reconcileDuplicateByPhone(tx, c.id))).toBe(c.id);
    for (const row of [a, b, c]) expect(await exists(row.id)).toBe(true);
  });
});

describe("findDuplicateCandidates", () => {
  it("lists other records on the number and says why each is not merged automatically", async () => {
    const phone = uniquePhone();
    const self = await seedCustomer({ phone, firstName: "Fran", lastName: "Ibarra" });
    const sameName = await seedCustomer({ phone, firstName: "Fran", lastName: "Ibarra" });
    const otherName = await seedCustomer({ phone, firstName: "Gus", lastName: "Ibarra" });
    const found = await findDuplicateCandidates(self.id);
    const byId = new Map(found.map((c) => [c.id, c]));
    expect(found).toHaveLength(2);
    expect(byId.get(otherName.id)?.blockedReason).toBe("names_differ");
    // One matching record only: it will be merged automatically.
    expect(byId.get(sameName.id)?.blockedReason).toBeNull();
  });

  it("flags several matching records and two records that have both bought", async () => {
    const phone = uniquePhone();
    const self = await seedCustomer({ phone, firstName: "Hana", lastName: "Ruiz" });
    const one = await seedCustomer({ phone, firstName: "Hana", lastName: "Ruiz" });
    const two = await seedCustomer({ phone, firstName: "Hana", lastName: "Ruiz" });
    expect((await findDuplicateCandidates(self.id)).map((c) => c.blockedReason)).toEqual(["several_matching_records", "several_matching_records"]);
    await purchase(self.id); await purchase(one.id);
    const found = new Map((await findDuplicateCandidates(self.id)).map((c) => [c.id, c]));
    expect(found.get(one.id)).toMatchObject({ blockedReason: "both_purchased", completedOrders: 1 });
    expect(found.get(two.id)?.completedOrders).toBe(0);
  });

  it("returns nothing for a customer without a usable phone, or with no other record on it", async () => {
    expect(await findDuplicateCandidates((await seedCustomer({ phone: null })).id)).toEqual([]);
    expect(await findDuplicateCandidates((await seedCustomer({ phone: uniquePhone() })).id)).toEqual([]);
  });
});

describe("mergeCustomersByStaff", () => {
  it("merges two records the automatic rules would decline, keeps the older, and records who asked", async () => {
    const phone = uniquePhone();
    const older = await seedCustomer({ phone, firstName: "Ines", lastName: "Vega", createdAt: new Date("2026-09-01T00:00:00Z") });
    const newer = await seedCustomer({ phone, firstName: "Inez", lastName: "Vega", createdAt: new Date("2026-10-01T00:00:00Z") });
    // Asking from the newer record's side still keeps the older one.
    const summary = await mergeCustomersByStaff(newer.id, older.id, "admin@example.com");
    expect(summary.survivorId).toBe(older.id);
    expect(await exists(newer.id)).toBe(false);
    const [note] = await db.select().from(customerNotesTable).where(eq(customerNotesTable.customerId, older.id));
    expect(note.body).toContain("by admin@example.com");
  });

  it("refuses records that do not share a phone number, or that have both bought", async () => {
    const a = await seedCustomer({ phone: uniquePhone() }); const b = await seedCustomer({ phone: uniquePhone() });
    await expect(mergeCustomersByStaff(a.id, b.id, "admin@example.com")).rejects.toBeInstanceOf(MergeRefusedError);
    const phone = uniquePhone();
    const c = await seedCustomer({ phone }); const d = await seedCustomer({ phone });
    await purchase(c.id); await purchase(d.id);
    await expect(mergeCustomersByStaff(c.id, d.id, "admin@example.com")).rejects.toBeInstanceOf(MergeRefusedError);
    expect(await exists(c.id)).toBe(true);
    expect(await exists(d.id)).toBe(true);
  });
});

