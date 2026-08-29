import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

const PASSWORD = "CorrectHorseBattery1";

async function seedUser(email: string, role: "admin" | "manager" | "customer_service") {
  const { db, appUsersTable } = await import("@luma/db");
  const { hashPassword } = await import("../lib/crypto.js");
  const [user] = await db
    .insert(appUsersTable)
    .values({ email, normalizedEmail: email, role, status: "active", passwordHash: await hashPassword(PASSWORD) })
    .returning();
  return user;
}

async function loginAgent(app: ReturnType<typeof createApp>, email: string) {
  const agent = request.agent(app);
  const csrf = (await agent.get("/api/app/auth/csrf-token")).body.csrfToken as string;
  await agent.post("/api/app/auth/login").set("x-csrf-token", csrf).send({ email, password: PASSWORD });
  return { agent, csrf };
}

describe("Customers CRUD", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/customers");
    expect(res.status).toBe(401);
  });

  it("rejects customer_service role from the Leads list, but allows reading a single customer — this powers the identity-confirmation link on Unmatched Contacts", async () => {
    const { db, customersTable } = await import("@luma/db");
    const [customer] = await db
      .insert(customersTable)
      .values({ firstName: "Cs", lastName: "Target", email: "cs-target@example.com", leadReceivedDate: "2026-01-01" })
      .returning();

    await seedUser("cs1@example.com", "customer_service");
    const { agent } = await loginAgent(app, "cs1@example.com");

    const listRes = await agent.get("/api/app/customers");
    expect(listRes.status).toBe(403);

    const detailRes = await agent.get(`/api/app/customers/${customer!.id}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.customer.email).toBe("cs-target@example.com");
  });

  it("manager can read customers but not create one — read-only access to Leads", async () => {
    await seedUser("manager1@example.com", "manager");
    const { agent, csrf } = await loginAgent(app, "manager1@example.com");

    const listRes = await agent.get("/api/app/customers");
    expect(listRes.status).toBe(200);

    const createRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "A", lastName: "B", email: "ab@example.com", leadReceivedDate: "2026-01-01" });
    expect(createRes.status).toBe(403);
  });

  it("admin can create, read, update a customer and add a purchase", async () => {
    await seedUser("admin1@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin1@example.com");

    const createRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({
        firstName: "Jane",
        lastName: "Doe",
        email: "jane.doe@example.com",
        phone: "+12025550100",
        leadReceivedDate: "2026-01-15",
      });
    expect(createRes.status).toBe(201);
    const customer = createRes.body.customer;
    expect(customer.personNumber).toMatch(/^PER-\d{6}$/);

    const getRes = await agent.get(`/api/app/customers/${customer.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.customer.email).toBe("jane.doe@example.com");
    expect(getRes.body.purchases).toEqual([]);
    expect(getRes.body.questionnaireEvents).toEqual([]);

    // Detail response surfaces every questionnaire this customer has an
    // event for, most recently active first.
    const { db, questionnaireEventsTable } = await import("@luma/db");
    await db.insert(questionnaireEventsTable).values({
      personId: customer.id,
      questionnaireId: "Q-OLDER",
      status: "started",
      lastEventAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.insert(questionnaireEventsTable).values({
      personId: customer.id,
      questionnaireId: "Q-NEWER",
      status: "abandoned",
      lastEventAt: new Date("2026-02-01T00:00:00Z"),
    });
    const withEvents = await agent.get(`/api/app/customers/${customer.id}`);
    expect(withEvents.body.questionnaireEvents).toHaveLength(2);
    expect(withEvents.body.questionnaireEvents[0].questionnaireId).toBe("Q-NEWER");
    expect(withEvents.body.questionnaireEvents[0].status).toBe("abandoned");
    expect(withEvents.body.questionnaireEvents[1].questionnaireId).toBe("Q-OLDER");

    const updateRes = await agent
      .patch(`/api/app/customers/${customer.id}`)
      .set("x-csrf-token", csrf)
      .send({ leadType: "Referral" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.customer.leadType).toBe("Referral");

    // First purchase -> classified first_order
    const purchase1 = await agent
      .post(`/api/app/customers/${customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-02-01", orderNumber: "ORD-1", productName: "Widget", amountPaid: "49.99" });
    expect(purchase1.status).toBe(201);
    expect(purchase1.body.purchase.orderClassification).toBe("first_order");

    // A second purchase dated after the first should be classified "recurring".
    const purchase2 = await agent
      .post(`/api/app/customers/${customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-03-01", orderNumber: "ORD-2", productName: "Widget 2", amountPaid: "19.99" });
    expect(purchase2.status).toBe(201);
    expect(purchase2.body.purchase.orderClassification).toBe("recurring");

    const detailRes = await agent.get(`/api/app/customers/${customer.id}`);
    expect(detailRes.body.purchases).toHaveLength(2);
  });

  it("search finds customers by name/email, and list includes purchase aggregates", async () => {
    await seedUser("admin2@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin2@example.com");

    const createRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Zoltan", lastName: "Searchable", email: "zoltan@example.com", leadReceivedDate: "2026-01-01" });
    const customerId = createRes.body.customer.id;
    await agent
      .post(`/api/app/customers/${customerId}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-05", orderNumber: "ORD-Z1", productName: "Thing", amountPaid: "100.00" });

    const searchRes = await agent.get("/api/app/customers").query({ search: "Zoltan" });
    expect(searchRes.status).toBe(200);
    expect(searchRes.body.customers).toHaveLength(1);
    expect(searchRes.body.customers[0].purchaseCount).toBe(1);
    expect(searchRes.body.customers[0].totalPaid).toBe("100.00");

    const noMatch = await agent.get("/api/app/customers").query({ search: "no-such-customer-xyz" });
    expect(noMatch.body.customers).toHaveLength(0);
    expect(noMatch.body.total).toBe(0);
  });

  it("search finds a customer by their full name, not just first or last name alone", async () => {
    await seedUser("admin-fullname@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-fullname@example.com");

    await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Teresa", lastName: "Holley", email: "teresa.holley@example.com", leadReceivedDate: "2026-01-01" });

    const fullNameRes = await agent.get("/api/app/customers").query({ search: "Teresa Holley" });
    expect(fullNameRes.status).toBe(200);
    expect(fullNameRes.body.customers).toHaveLength(1);
    expect(fullNameRes.body.customers[0].lastName).toBe("Holley");
  });

  it("excludes a payment_failed purchase from orders/spent, so a declined charge doesn't read as real revenue next to a 'Not purchased' badge", async () => {
    await seedUser("admin-failedpay@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-failedpay@example.com");

    const createRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Joyce", lastName: "Sippel", email: "joyce.sippel@example.com", leadReceivedDate: "2026-01-01" });
    const customerId = createRes.body.customer.id;

    await agent
      .post(`/api/app/customers/${customerId}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-05", orderNumber: "ORD-FAILED-1", productName: "Thing", amountPaid: "169.00", status: "payment_failed" });

    const res = await agent.get("/api/app/customers").query({ search: "Sippel" });
    expect(res.body.customers).toHaveLength(1);
    expect(res.body.customers[0].purchaseCount).toBe(0);
    // "0" not "0.00" — coalesce's integer fallback, same formatting quirk a
    // customer with zero purchases at all already has; the frontend's
    // formatMoney() normalizes either through Number().toFixed(2).
    expect(res.body.customers[0].totalPaid).toBe("0");
    expect(res.body.customers[0].qualifyingPurchaseDate).toBeNull();
  });

  it("returns 404 for an unknown customer id", async () => {
    await seedUser("admin3@example.com", "admin");
    const { agent } = await loginAgent(app, "admin3@example.com");
    const res = await agent.get("/api/app/customers/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("filters by leadType, purchaseStatus, and questionnaireId", async () => {
    await seedUser("admin6@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin6@example.com");

    const purchaser = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Filt", lastName: "Purchaser", email: "filt-purchaser@example.com", leadReceivedDate: "2026-01-01", leadType: "Referral Filter Test" });
    await agent
      .post(`/api/app/customers/${purchaser.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-05", orderNumber: "ORD-FILT-1", productName: "Thing", amountPaid: "10.00" });

    const nonPurchaser = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Filt", lastName: "NonPurchaser", email: "filt-nonpurchaser@example.com", leadReceivedDate: "2026-01-01", leadType: "Referral Filter Test" });

    const byLeadType = await agent.get("/api/app/customers").query({ leadType: "Referral Filter Test" });
    expect(byLeadType.body.total).toBe(2);

    const purchasedOnly = await agent.get("/api/app/customers").query({ leadType: "Referral Filter Test", purchaseStatus: "purchased" });
    expect(purchasedOnly.body.total).toBe(1);
    expect(purchasedOnly.body.customers[0].id).toBe(purchaser.body.customer.id);

    const notPurchasedOnly = await agent.get("/api/app/customers").query({ leadType: "Referral Filter Test", purchaseStatus: "not_purchased" });
    expect(notPurchasedOnly.body.total).toBe(1);
    expect(notPurchasedOnly.body.customers[0].id).toBe(nonPurchaser.body.customer.id);

    // A lead whose only purchase is classified "recurring" must land in
    // not_purchased, not purchased — same rule as the summary tiles.
    const recurringOnlyLead = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Filt", lastName: "RecurringOnly", email: "filt-recurring-only@example.com", leadReceivedDate: "2026-01-01", leadType: "Referral Filter Test" });
    const recurringOnlyPurchase = await agent
      .post(`/api/app/customers/${recurringOnlyLead.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-05", orderNumber: "ORD-FILT-RECURRING", productName: "Thing", amountPaid: "10.00" });
    await agent
      .patch(`/api/app/purchases/${recurringOnlyPurchase.body.purchase.id}`)
      .set("x-csrf-token", csrf)
      .send({ orderClassification: "recurring" });

    const notPurchasedWithRecurring = await agent.get("/api/app/customers").query({ leadType: "Referral Filter Test", purchaseStatus: "not_purchased" });
    expect(notPurchasedWithRecurring.body.total).toBe(2);
    expect(notPurchasedWithRecurring.body.customers.map((c: { id: string }) => c.id).sort()).toEqual(
      [nonPurchaser.body.customer.id, recurringOnlyLead.body.customer.id].sort(),
    );

    const purchasedStillExcludesRecurring = await agent.get("/api/app/customers").query({ leadType: "Referral Filter Test", purchaseStatus: "purchased" });
    expect(purchasedStillExcludesRecurring.body.total).toBe(1);
    expect(purchasedStillExcludesRecurring.body.customers[0].id).toBe(purchaser.body.customer.id);

    // The row-level badge date (qualifyingPurchaseDate) is null for the
    // recurring-only lead even though it has purchase history.
    const allThree = await agent.get("/api/app/customers").query({ leadType: "Referral Filter Test" });
    const recurringOnlyRow = allThree.body.customers.find((c: { id: string }) => c.id === recurringOnlyLead.body.customer.id);
    expect(recurringOnlyRow.qualifyingPurchaseDate).toBeNull();
    expect(recurringOnlyRow.purchaseCount).toBe(1); // still visible in full order history

    // questionnaireId filter + the status field still being surfaced on the list itself
    const { db, questionnaireEventsTable } = await import("@luma/db");
    await db.insert(questionnaireEventsTable).values({
      personId: nonPurchaser.body.customer.id,
      questionnaireId: "Q-FILT-1",
      status: "abandoned",
      lastEventAt: new Date(),
    });
    const byQuestionnaireId = await agent.get("/api/app/customers").query({ leadType: "Referral Filter Test", questionnaireId: "Q-FILT-1" });
    expect(byQuestionnaireId.body.total).toBe(1);
    expect(byQuestionnaireId.body.customers[0].id).toBe(nonPurchaser.body.customer.id);
    expect(byQuestionnaireId.body.customers[0].questionnaireStatus).toBe("abandoned");
    expect(byQuestionnaireId.body.customers[0].questionnaireId).toBe("Q-FILT-1");

    // A different questionnaire ID shouldn't match this customer's event.
    const byOtherQuestionnaireId = await agent.get("/api/app/customers").query({ leadType: "Referral Filter Test", questionnaireId: "Q-DOES-NOT-EXIST" });
    expect(byOtherQuestionnaireId.body.total).toBe(0);
  });

  it("filters by leadReceivedDate range (dateFrom/dateTo), and sorts by leadReceivedDate/lastName", async () => {
    await seedUser("admin-daterange@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-daterange@example.com");

    const jan = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Aaron", lastName: "Alpha", email: "date-jan@example.com", leadReceivedDate: "2026-01-01", leadType: "Date Range Test" });
    const feb = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Zed", lastName: "Bravo", email: "date-feb@example.com", leadReceivedDate: "2026-02-15", leadType: "Date Range Test" });
    const mar = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Mia", lastName: "Charlie", email: "date-mar@example.com", leadReceivedDate: "2026-03-01", leadType: "Date Range Test" });

    const rangeRes = await agent
      .get("/api/app/customers")
      .query({ leadType: "Date Range Test", dateFrom: "2026-02-01", dateTo: "2026-02-28" });
    expect(rangeRes.body.total).toBe(1);
    expect(rangeRes.body.customers[0].id).toBe(feb.body.customer.id);

    const fromOnlyRes = await agent.get("/api/app/customers").query({ leadType: "Date Range Test", dateFrom: "2026-02-01" });
    expect(fromOnlyRes.body.total).toBe(2);
    expect(fromOnlyRes.body.customers.map((c: { id: string }) => c.id).sort()).toEqual([feb.body.customer.id, mar.body.customer.id].sort());

    const sortedByDate = await agent
      .get("/api/app/customers")
      .query({ leadType: "Date Range Test", sortBy: "leadReceivedDate", sortDir: "asc" });
    expect(sortedByDate.body.customers.map((c: { id: string }) => c.id)).toEqual([jan.body.customer.id, feb.body.customer.id, mar.body.customer.id]);

    const sortedByLastName = await agent
      .get("/api/app/customers")
      .query({ leadType: "Date Range Test", sortBy: "lastName", sortDir: "asc" });
    expect(sortedByLastName.body.customers.map((c: { id: string }) => c.id)).toEqual([jan.body.customer.id, feb.body.customer.id, mar.body.customer.id]);
  });
});

describe("Customers summary", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("computes totals, purchased/not-purchased split, and conversion rate", async () => {
    await seedUser("admin-summary@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-summary@example.com");

    const purchaser = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Sum", lastName: "Purchaser", email: "sum-purchaser@example.com", leadReceivedDate: "2026-01-01", leadType: "web-form" });
    await agent
      .post(`/api/app/customers/${purchaser.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-05", orderNumber: "ORD-SUM-1", productName: "Thing", amountPaid: "10.00" });

    await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Sum", lastName: "NonPurchaser", email: "sum-nonpurchaser@example.com", leadReceivedDate: "2026-01-01", leadType: "Bask abandoned cart" });

    const res = await agent.get("/api/app/customers/summary").query({ period: "all" });
    expect(res.status).toBe(200);
    expect(res.body.totalLeads).toBeGreaterThanOrEqual(2);
    expect(res.body.purchased).toBeGreaterThanOrEqual(1);
    expect(res.body.notPurchased).toBe(res.body.totalLeads - res.body.purchased);
    expect(res.body.conversionRate).toBeGreaterThan(0);
  });

  it("does not count a recurring-only purchase as 'purchased' — only a completed first-order purchase converts a lead", async () => {
    await seedUser("admin-summary-recurring@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-summary-recurring@example.com");

    const before = await agent.get("/api/app/customers/summary").query({ period: "all" });

    // Lead whose first purchase is a real first_order — should count.
    const converted = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Rec", lastName: "Converted", email: "rec-converted@example.com", leadReceivedDate: "2026-01-01" });
    await agent
      .post(`/api/app/customers/${converted.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-05", orderNumber: "ORD-REC-1", productName: "Thing", amountPaid: "10.00" });

    // Lead whose only purchase is classified "recurring" (e.g. a backfilled
    // order) — must NOT count as purchased, mirroring Marketing CPA's rule.
    const recurringOnly = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Rec", lastName: "OnlyRecurring", email: "rec-only-recurring@example.com", leadReceivedDate: "2026-01-01" });
    const recurringPurchase = await agent
      .post(`/api/app/customers/${recurringOnly.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-05", orderNumber: "ORD-REC-2", productName: "Thing", amountPaid: "10.00" });
    await agent
      .patch(`/api/app/purchases/${recurringPurchase.body.purchase.id}`)
      .set("x-csrf-token", csrf)
      .send({ orderClassification: "recurring" });

    const after = await agent.get("/api/app/customers/summary").query({ period: "all" });
    expect(after.body.totalLeads - before.body.totalLeads).toBe(2); // both leads are in scope
    expect(after.body.purchased - before.body.purchased).toBe(1); // only the first_order one converts
  });

  it("classifies leads into metaFormFillCount/questionnaireCount by first-touch source, no double-counting", async () => {
    await seedUser("admin-source@example.com", "admin");
    const { agent } = await loginAgent(app, "admin-source@example.com");

    const { db, customersTable, externalIdentitiesTable } = await import("@luma/db");
    const [ghlLead] = await db
      .insert(customersTable)
      .values({ firstName: "GHL", lastName: "Sourced", email: "ghl-sourced@example.com", leadReceivedDate: "2026-01-01" })
      .returning();
    await db.insert(externalIdentitiesTable).values({ personId: ghlLead!.id, system: "ghl", externalId: "ghl-src-1" });

    const [baskLead] = await db
      .insert(customersTable)
      .values({ firstName: "Bask", lastName: "Sourced", email: "bask-sourced@example.com", leadReceivedDate: "2026-01-01" })
      .returning();
    await db.insert(externalIdentitiesTable).values({ personId: baskLead!.id, system: "bask", externalId: "bask-src-1" });

    // Touched by GHL first, then later also by Bask — must still count once, under GHL.
    const [bothLead] = await db
      .insert(customersTable)
      .values({ firstName: "Both", lastName: "Sourced", email: "both-sourced@example.com", leadReceivedDate: "2026-01-01" })
      .returning();
    await db
      .insert(externalIdentitiesTable)
      .values({ personId: bothLead!.id, system: "ghl", externalId: "both-src-ghl", createdAt: new Date("2026-01-01T00:00:00Z") });
    await db
      .insert(externalIdentitiesTable)
      .values({ personId: bothLead!.id, system: "bask", externalId: "both-src-bask", createdAt: new Date("2026-01-02T00:00:00Z") });

    const res = await agent.get("/api/app/customers/summary").query({ period: "all" });
    expect(res.status).toBe(200);
    expect(res.body.metaFormFillCount).toBeGreaterThanOrEqual(2); // ghlLead + bothLead
    expect(res.body.questionnaireCount).toBeGreaterThanOrEqual(1); // baskLead only
    expect(res.body.metaFormFillCount + res.body.questionnaireCount).toBeLessThanOrEqual(res.body.totalLeads);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/customers/summary");
    expect(res.status).toBe(401);
  });
});

describe("Customers lead-types", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("returns distinct lead types", async () => {
    await seedUser("admin-leadtypes@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-leadtypes@example.com");

    await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "LT", lastName: "One", email: "lt-one@example.com", leadReceivedDate: "2026-01-01", leadType: "Distinct Lead Type Test" });
    await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "LT", lastName: "Two", email: "lt-two@example.com", leadReceivedDate: "2026-01-01", leadType: "Distinct Lead Type Test" });

    const res = await agent.get("/api/app/customers/lead-types");
    expect(res.status).toBe(200);
    const occurrences = res.body.leadTypes.filter((lt: string) => lt === "Distinct Lead Type Test");
    expect(occurrences).toHaveLength(1); // distinct, not once per customer
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/customers/lead-types");
    expect(res.status).toBe(401);
  });
});

describe("Customers questionnaire-ids", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("returns distinct questionnaire IDs, not statuses", async () => {
    await seedUser("admin-qids@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-qids@example.com");

    const one = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Q", lastName: "One", email: "q-one@example.com", leadReceivedDate: "2026-01-01" });
    const two = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Q", lastName: "Two", email: "q-two@example.com", leadReceivedDate: "2026-01-01" });

    const { db, questionnaireEventsTable } = await import("@luma/db");
    await db.insert(questionnaireEventsTable).values([
      { personId: one.body.customer.id, questionnaireId: "Q-DISTINCT-9914", status: "submitted", lastEventAt: new Date() },
      { personId: two.body.customer.id, questionnaireId: "Q-DISTINCT-9914", status: "abandoned", lastEventAt: new Date() },
    ]);

    const res = await agent.get("/api/app/customers/questionnaire-ids");
    expect(res.status).toBe(200);
    const occurrences = res.body.questionnaireIds.filter((qid: string) => qid === "Q-DISTINCT-9914");
    expect(occurrences).toHaveLength(1); // distinct, not once per event/customer
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/customers/questionnaire-ids");
    expect(res.status).toBe(401);
  });
});

describe("Purchases", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("admin can update classification, which writes an audit row", async () => {
    await seedUser("admin4@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin4@example.com");

    const customerRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Purch", lastName: "Aser", email: "purchaser@example.com", leadReceivedDate: "2026-01-01" });
    const customerId = customerRes.body.customer.id;

    const purchaseRes = await agent
      .post(`/api/app/customers/${customerId}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-10", orderNumber: "ORD-X", productName: "Gadget", amountPaid: "75.00" });
    const purchaseId = purchaseRes.body.purchase.id;
    expect(purchaseRes.body.purchase.orderClassification).toBe("first_order");

    const updateRes = await agent
      .patch(`/api/app/purchases/${purchaseId}`)
      .set("x-csrf-token", csrf)
      .send({ orderClassification: "recurring" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.purchase.orderClassification).toBe("recurring");
    expect(updateRes.body.purchase.orderClassificationSource).toBe("manual");

    const { db, purchaseClassificationAuditsTable } = await import("@luma/db");
    const { eq } = await import("drizzle-orm");
    const audits = await db
      .select()
      .from(purchaseClassificationAuditsTable)
      .where(eq(purchaseClassificationAuditsTable.purchaseId, purchaseId));
    expect(audits).toHaveLength(1);
    expect(audits[0].previousClassification).toBe("first_order");
    expect(audits[0].newClassification).toBe("recurring");
    expect(audits[0].changedBy).toBe("admin4@example.com");
  });

  it("clears a customer's do-not-disturb flag on both channels when a purchase is recorded", async () => {
    await seedUser("admin-dnd@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-dnd@example.com");

    const customerRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Opted", lastName: "Out", email: "opted-out@example.com", leadReceivedDate: "2026-01-01" });
    const customerId = customerRes.body.customer.id;

    const { setCustomerSmsDnd, isCustomerSmsDnd, setCustomerEmailDnd, isCustomerEmailDnd } = await import("../services/dnd.service.js");
    await setCustomerSmsDnd(customerId, true);
    await setCustomerEmailDnd(customerId, true);
    expect(await isCustomerSmsDnd(customerId)).toBe(true);
    expect(await isCustomerEmailDnd(customerId)).toBe(true);

    const purchaseRes = await agent
      .post(`/api/app/customers/${customerId}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-10", orderNumber: "ORD-DND", productName: "Gadget", amountPaid: "75.00" });
    expect(purchaseRes.status).toBe(201);

    expect(await isCustomerSmsDnd(customerId)).toBe(false);
    expect(await isCustomerEmailDnd(customerId)).toBe(false);
  });

  it("returns 404 for an unknown purchase id", async () => {
    await seedUser("admin5@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin5@example.com");
    const res = await agent.patch("/api/app/purchases/999999999").set("x-csrf-token", csrf).send({ status: "refunded" });
    expect(res.status).toBe(404);
  });

  it("classifies exactly one of two concurrently-created purchases as first_order, not both", async () => {
    await seedUser("admin-race@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-race@example.com");

    const customerRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Race", lastName: "Condition", email: "race-condition@example.com", leadReceivedDate: "2026-01-01" });
    const customerId = customerRes.body.customer.id;

    // Two purchases fired concurrently, same purchase date, so neither can
    // win the "earlier purchase" check by being submitted first — this is
    // exactly the shape of two near-simultaneous webhook deliveries. The
    // per-customer row lock in createPurchase must serialize them so only
    // one ends up first_order.
    const [r1, r2] = await Promise.all([
      agent
        .post(`/api/app/customers/${customerId}/purchases`)
        .set("x-csrf-token", csrf)
        .send({ purchaseDate: "2026-02-01", orderNumber: "ORD-RACE-1", productName: "Widget", amountPaid: "49.99" }),
      agent
        .post(`/api/app/customers/${customerId}/purchases`)
        .set("x-csrf-token", csrf)
        .send({ purchaseDate: "2026-02-01", orderNumber: "ORD-RACE-2", productName: "Widget", amountPaid: "49.99" }),
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const classifications = [r1.body.purchase.orderClassification, r2.body.purchase.orderClassification].sort();
    expect(classifications).toEqual(["first_order", "recurring"]);
  });

  it("rejects reclassifying a purchase to first_order when the customer already has one", async () => {
    await seedUser("admin-dup-first-order@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-dup-first-order@example.com");

    const customerRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Dup", lastName: "FirstOrder", email: "dup-first-order@example.com", leadReceivedDate: "2026-01-01" });
    const customerId = customerRes.body.customer.id;

    const purchase1 = await agent
      .post(`/api/app/customers/${customerId}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-01", orderNumber: "ORD-DUP-1", productName: "Thing", amountPaid: "10.00" });
    expect(purchase1.body.purchase.orderClassification).toBe("first_order");

    const purchase2 = await agent
      .post(`/api/app/customers/${customerId}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-02-01", orderNumber: "ORD-DUP-2", productName: "Thing", amountPaid: "10.00" });
    expect(purchase2.body.purchase.orderClassification).toBe("recurring");

    const reclassify = await agent
      .patch(`/api/app/purchases/${purchase2.body.purchase.id}`)
      .set("x-csrf-token", csrf)
      .send({ orderClassification: "first_order" });
    expect(reclassify.status).toBe(409);
  });

  it("lists purchases across all customers with the customer's name attached, with a stable order for same-date purchases", async () => {
    // Shares one login for both concerns — the auth rate limiter caps
    // logins per test file, and this file is already close to that cap.
    await seedUser("admin-orders@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-orders@example.com");

    const customerRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Order", lastName: "Placer", email: "order-placer@example.com", leadReceivedDate: "2026-01-01" });
    await agent
      .post(`/api/app/customers/${customerRes.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-10", orderNumber: "ORD-LIST-1", productName: "Gizmo", amountPaid: "25.00" });

    // Two more orders on the exact same date, created back to back —
    // without an id tiebreak, Postgres has no guaranteed order among ties,
    // so a real order can silently land on a different page each time the
    // list is requested even though the webhook that created it succeeded.
    await agent
      .post(`/api/app/customers/${customerRes.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-03-01", orderNumber: "ORD-STABLE-A", productName: "Gizmo", amountPaid: "25.00" });
    await agent
      .post(`/api/app/customers/${customerRes.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-03-01", orderNumber: "ORD-STABLE-B", productName: "Gizmo", amountPaid: "25.00" });

    // limit:100 (the max) rather than a small page size — this shared test DB
    // accumulates purchase rows from other test files running concurrently in
    // the same schema, so a small limit risks this test's own row falling off
    // the page purely due to how many other purchases happen to sort above it.
    const res = await agent.get("/api/app/purchases").query({ limit: 100, sortBy: "purchaseDate", sortDir: "asc" });
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const row = res.body.purchases.find((p: { orderNumber: string }) => p.orderNumber === "ORD-LIST-1");
    expect(row.customerFirstName).toBe("Order");
    expect(row.customerLastName).toBe("Placer");

    const indexA = res.body.purchases.findIndex((p: { orderNumber: string }) => p.orderNumber === "ORD-STABLE-A");
    const indexB = res.body.purchases.findIndex((p: { orderNumber: string }) => p.orderNumber === "ORD-STABLE-B");
    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexB).toBeGreaterThanOrEqual(0);
    // Tied on purchaseDate, so the id tiebreak decides — A was inserted
    // first, so it must sort before B every time, not just by chance.
    expect(indexA).toBeLessThan(indexB);
  });

  it("filters by orderClassification (first_order vs recurring) and by status, sorting oldest-first when asked", async () => {
    // Shares one login for both concerns — the auth rate limiter caps
    // logins per test file, and this file is already close to that cap.
    await seedUser("admin-order-class-filter@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-order-class-filter@example.com");

    const customerRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Class", lastName: "Filter", email: "class-filter@example.com", leadReceivedDate: "2026-01-01" });
    const customerId = customerRes.body.customer.id;

    const firstOrder = await agent
      .post(`/api/app/customers/${customerId}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-01", orderNumber: "ORD-CLASS-1", productName: "Thing", amountPaid: "10.00" });
    expect(firstOrder.body.purchase.orderClassification).toBe("first_order");

    const recurringOrder = await agent
      .post(`/api/app/customers/${customerId}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-02", orderNumber: "ORD-CLASS-2", productName: "Thing", amountPaid: "20.00", status: "payment_failed" });
    expect(recurringOrder.body.purchase.orderClassification).toBe("recurring");
    expect(recurringOrder.body.purchase.status).toBe("payment_failed");

    const newerFailed = await agent
      .post(`/api/app/customers/${customerId}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-03", orderNumber: "ORD-CLASS-NEWER-FAILED", productName: "Thing", amountPaid: "15.00", status: "payment_failed" });
    expect(newerFailed.body.purchase.status).toBe("payment_failed");

    const firstOnly = await agent.get("/api/app/purchases").query({ orderClassification: "first_order", limit: 100 });
    expect(firstOnly.body.purchases.some((p: { orderNumber: string }) => p.orderNumber === "ORD-CLASS-1")).toBe(true);
    expect(firstOnly.body.purchases.some((p: { orderNumber: string }) => p.orderNumber === "ORD-CLASS-2")).toBe(false);

    const recurringOnly = await agent.get("/api/app/purchases").query({ orderClassification: "recurring", limit: 100 });
    expect(recurringOnly.body.purchases.some((p: { orderNumber: string }) => p.orderNumber === "ORD-CLASS-2")).toBe(true);
    expect(recurringOnly.body.purchases.some((p: { orderNumber: string }) => p.orderNumber === "ORD-CLASS-1")).toBe(false);

    // Status filter, for the Orders page's "Payment Failed" view.
    const failedOnly = await agent.get("/api/app/purchases").query({ status: "payment_failed", limit: 100 });
    const failedOrderNumbers = failedOnly.body.purchases.map((p: { orderNumber: string }) => p.orderNumber);
    expect(failedOrderNumbers).toContain("ORD-CLASS-2");
    expect(failedOrderNumbers).toContain("ORD-CLASS-NEWER-FAILED");
    expect(failedOrderNumbers).not.toContain("ORD-CLASS-1");

    // Oldest-first sort, for surfacing the longest-unresolved failures first.
    const oldestFirst = await agent.get("/api/app/purchases").query({ status: "payment_failed", sortBy: "purchaseDate", sortDir: "asc", limit: 100 });
    const olderIndex = oldestFirst.body.purchases.findIndex((p: { orderNumber: string }) => p.orderNumber === "ORD-CLASS-2");
    const newerIndex = oldestFirst.body.purchases.findIndex((p: { orderNumber: string }) => p.orderNumber === "ORD-CLASS-NEWER-FAILED");
    expect(olderIndex).toBeGreaterThanOrEqual(0);
    expect(olderIndex).toBeLessThan(newerIndex);

    // Orders search — matches the customer's full name exactly as displayed
    // (not separate firstName/lastName columns, same fix as Leads search),
    // customer email, or order number.
    const byName = await agent.get("/api/app/purchases").query({ search: "Class Filter", limit: 100 });
    expect(byName.body.purchases.some((p: { orderNumber: string }) => p.orderNumber === "ORD-CLASS-1")).toBe(true);

    const byEmail = await agent.get("/api/app/purchases").query({ search: "class-filter@example.com", limit: 100 });
    expect(byEmail.body.purchases.some((p: { orderNumber: string }) => p.orderNumber === "ORD-CLASS-1")).toBe(true);

    const byOrderNumber = await agent.get("/api/app/purchases").query({ search: "ORD-CLASS-NEWER-FAILED", limit: 100 });
    expect(byOrderNumber.body.purchases.map((p: { orderNumber: string }) => p.orderNumber)).toEqual(["ORD-CLASS-NEWER-FAILED"]);

    const noMatch = await agent.get("/api/app/purchases").query({ search: "no-such-order-or-person-xyz", limit: 100 });
    expect(noMatch.body.purchases).toEqual([]);
  });

  it("rejects unauthenticated requests to the purchases list", async () => {
    const res = await request(app).get("/api/app/purchases");
    expect(res.status).toBe(401);
  });

  it("manager can read purchases but not edit one (read-only Orders access); customer_service still cannot read", async () => {
    await seedUser("purchases-manager1@example.com", "manager");
    const manager = await loginAgent(app, "purchases-manager1@example.com");
    expect((await manager.agent.get("/api/app/purchases")).status).toBe(200);
    const editRes = await manager.agent.patch("/api/app/purchases/1").set("x-csrf-token", manager.csrf).send({ status: "completed" });
    expect(editRes.status).toBe(403);

    await seedUser("purchases-cs1@example.com", "customer_service");
    const cs = await loginAgent(app, "purchases-cs1@example.com");
    expect((await cs.agent.get("/api/app/purchases")).status).toBe(403);
  });

  it("computes purchasing/new/recurring customer counts and revenue, completed orders only", async () => {
    await seedUser("admin-orders-summary@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "admin-orders-summary@example.com");

    const repeat = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Sum", lastName: "Repeat", email: "sum-repeat@example.com", leadReceivedDate: "2026-01-01" });
    const firstOrder = await agent
      .post(`/api/app/customers/${repeat.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-01", orderNumber: "ORD-SUM-1", productName: "Thing", amountPaid: "10.00" });
    expect(firstOrder.body.purchase.orderClassification).toBe("first_order");
    const secondOrder = await agent
      .post(`/api/app/customers/${repeat.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-02", orderNumber: "ORD-SUM-2", productName: "Thing", amountPaid: "20.00" });
    expect(secondOrder.body.purchase.orderClassification).toBe("recurring");

    // A cancelled purchase should not count toward completed-only totals.
    const oneOff = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Sum", lastName: "Cancelled", email: "sum-cancelled@example.com", leadReceivedDate: "2026-01-01" });
    const cancelledPurchase = await agent
      .post(`/api/app/customers/${oneOff.body.customer.id}/purchases`)
      .set("x-csrf-token", csrf)
      .send({ purchaseDate: "2026-01-01", orderNumber: "ORD-SUM-3", productName: "Thing", amountPaid: "999.00" });
    await agent
      .patch(`/api/app/purchases/${cancelledPurchase.body.purchase.id}`)
      .set("x-csrf-token", csrf)
      .send({ status: "cancelled" });

    const res = await agent.get("/api/app/purchases/summary").query({ period: "all" });
    expect(res.status).toBe(200);
    expect(res.body.purchasingCustomers).toBeGreaterThanOrEqual(1);
    expect(res.body.newCustomers).toBeGreaterThanOrEqual(1);
    expect(res.body.recurringCustomers).toBeGreaterThanOrEqual(1);
    expect(Number(res.body.totalRevenue)).toBeGreaterThanOrEqual(30);
    // The $999 cancelled purchase must not be counted.
    expect(res.body.totalRevenue).not.toContain("999");
  });

  it("rejects unauthenticated requests to the purchases summary", async () => {
    const res = await request(app).get("/api/app/purchases/summary");
    expect(res.status).toBe(401);
  });
});

describe("Intake link", () => {
  let app: ReturnType<typeof createApp>;
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.INTAKE_LINK_BASE_URL = "http://localhost:3000";
    process.env.BASK_QUESTIONNAIRE_URL = "https://bask.example.com/questionnaire";
    app = createApp();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("admin can generate a signup link for a lead", async () => {
    await seedUser("intake-admin1@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "intake-admin1@example.com");

    const customerRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Intake", lastName: "Lead", email: "intake2@example.com", leadReceivedDate: "2026-08-15" });
    const customerId = customerRes.body.customer.id;

    const res = await agent.post(`/api/app/customers/${customerId}/intake-link`).set("x-csrf-token", csrf).send({});
    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/^http:\/\/localhost:3000\/go\/.+/);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects manager and customer_service roles — intake links are admin-only", async () => {
    await seedUser("intake-admin2@example.com", "admin");
    const admin = await loginAgent(app, "intake-admin2@example.com");
    const customerRes = await admin.agent
      .post("/api/app/customers")
      .set("x-csrf-token", admin.csrf)
      .send({ firstName: "Intake", lastName: "Lead", email: "intake3@example.com", leadReceivedDate: "2026-08-15" });
    const customerId = customerRes.body.customer.id;

    await seedUser("intake-manager1@example.com", "manager");
    const manager = await loginAgent(app, "intake-manager1@example.com");
    const managerRes = await manager.agent
      .post(`/api/app/customers/${customerId}/intake-link`)
      .set("x-csrf-token", manager.csrf)
      .send({});
    expect(managerRes.status).toBe(403);

    await seedUser("intake-cs1@example.com", "customer_service");
    const { agent, csrf } = await loginAgent(app, "intake-cs1@example.com");
    const res = await agent.post(`/api/app/customers/${customerId}/intake-link`).set("x-csrf-token", csrf).send({});
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown customer id", async () => {
    await seedUser("intake-admin3@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "intake-admin3@example.com");
    const res = await agent
      .post("/api/app/customers/00000000-0000-0000-0000-000000000000/intake-link")
      .set("x-csrf-token", csrf)
      .send({});
    expect(res.status).toBe(404);
  });
});

describe("Upcoming trigger", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("returns null when nothing is scheduled for this customer", async () => {
    await seedUser("trigger-admin1@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "trigger-admin1@example.com");
    const customerRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Trigger", lastName: "Lead", email: "trigger-route1@example.com", leadReceivedDate: "2026-08-15" });
    const customerId = customerRes.body.customer.id;

    const res = await agent.get(`/api/app/customers/${customerId}/upcoming-trigger`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ trigger: null });
  });

  it("returns the scheduled trigger for this customer", async () => {
    await seedUser("trigger-admin2@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "trigger-admin2@example.com");
    const customerRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Trigger", lastName: "Lead", email: "trigger-route2@example.com", leadReceivedDate: "2026-08-15" });
    const customerId = customerRes.body.customer.id;

    const { db, reviewRequestTriggersTable } = await import("@luma/db");
    const dueAt = new Date(Date.now() + 3_600_000);
    await db.insert(reviewRequestTriggersTable).values({ personId: customerId, dueAt });

    const res = await agent.get(`/api/app/customers/${customerId}/upcoming-trigger`);
    expect(res.status).toBe(200);
    expect(res.body.trigger).toMatchObject({ kind: "review_request_sms", label: "Review-request text", status: "pending" });
    expect(new Date(res.body.trigger.dueAt).getTime()).toBe(dueAt.getTime());
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/customers/00000000-0000-0000-0000-000000000000/upcoming-trigger");
    expect(res.status).toBe(401);
  });

  it("customer_service can read it too — this powers the banner on their own Conversations/Support pages", async () => {
    await seedUser("trigger-admin3@example.com", "admin");
    const admin = await loginAgent(app, "trigger-admin3@example.com");
    const customerRes = await admin.agent
      .post("/api/app/customers")
      .set("x-csrf-token", admin.csrf)
      .send({ firstName: "Trigger", lastName: "Lead", email: "trigger-route3@example.com", leadReceivedDate: "2026-08-15" });
    const customerId = customerRes.body.customer.id;

    await seedUser("trigger-cs1@example.com", "customer_service");
    const cs = await loginAgent(app, "trigger-cs1@example.com");
    const res = await cs.agent.get(`/api/app/customers/${customerId}/upcoming-trigger`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ trigger: null });
  });

  it("rejects manager on both the read and the cancel — manager can't reach Conversations/Support", async () => {
    await seedUser("trigger-mgr1@example.com", "manager");
    const { agent, csrf } = await loginAgent(app, "trigger-mgr1@example.com");
    const anyId = "00000000-0000-0000-0000-000000000000";
    expect((await agent.get(`/api/app/customers/${anyId}/upcoming-trigger`)).status).toBe(403);
    expect((await agent.post(`/api/app/customers/${anyId}/upcoming-trigger/cancel`).set("x-csrf-token", csrf).send({ kind: "follow_up" })).status).toBe(403);
  });

  it("cancels the pending trigger, and reports cancelled: false on a second attempt or a stale kind", async () => {
    await seedUser("trigger-admin4@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "trigger-admin4@example.com");
    const customerRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Trigger", lastName: "Lead", email: "trigger-route4@example.com", leadReceivedDate: "2026-08-15" });
    const customerId = customerRes.body.customer.id;

    const { db, reviewRequestTriggersTable } = await import("@luma/db");
    const { eq } = await import("drizzle-orm");
    const dueAt = new Date(Date.now() + 3_600_000);
    await db.insert(reviewRequestTriggersTable).values({ personId: customerId, dueAt });

    const cancelRes = await agent
      .post(`/api/app/customers/${customerId}/upcoming-trigger/cancel`)
      .set("x-csrf-token", csrf)
      .send({ kind: "review_request_sms" });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body).toEqual({ cancelled: true });

    const [trigger] = await db.select().from(reviewRequestTriggersTable).where(eq(reviewRequestTriggersTable.personId, customerId));
    expect(trigger.status).toBe("cancelled");
    expect(trigger.cancelledReason).toBe("staff_cancelled");

    const afterRes = await agent.get(`/api/app/customers/${customerId}/upcoming-trigger`);
    expect(afterRes.body).toEqual({ trigger: null });

    // Already cancelled — a second attempt (e.g. a stale banner, or the customer's follow-up sent in the meantime) is a no-op, not an error.
    const secondCancelRes = await agent
      .post(`/api/app/customers/${customerId}/upcoming-trigger/cancel`)
      .set("x-csrf-token", csrf)
      .send({ kind: "review_request_sms" });
    expect(secondCancelRes.status).toBe(200);
    expect(secondCancelRes.body).toEqual({ cancelled: false });
  });

  it("rejects unauthenticated cancel requests, and an invalid kind with 400", async () => {
    const anyId = "00000000-0000-0000-0000-000000000000";
    const unauthRes = await request(app).post(`/api/app/customers/${anyId}/upcoming-trigger/cancel`).send({ kind: "follow_up" });
    expect(unauthRes.status).toBe(401);

    await seedUser("trigger-admin5@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "trigger-admin5@example.com");
    const badKindRes = await agent.post(`/api/app/customers/${anyId}/upcoming-trigger/cancel`).set("x-csrf-token", csrf).send({ kind: "not_a_real_kind" });
    expect(badKindRes.status).toBe(400);
  });
});

describe("Customer notes", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("admin adds a note, and it lists newest first", async () => {
    await seedUser("notes-admin1@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "notes-admin1@example.com");
    const customerRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Note", lastName: "Subject", email: "note-subject1@example.com", leadReceivedDate: "2026-08-15" });
    const customerId = customerRes.body.customer.id;

    const firstRes = await agent.post(`/api/app/customers/${customerId}/notes`).set("x-csrf-token", csrf).send({ body: "Called to confirm address." });
    expect(firstRes.status).toBe(201);
    expect(firstRes.body.note).toMatchObject({ customerId, authorEmail: "notes-admin1@example.com", body: "Called to confirm address." });

    const secondRes = await agent.post(`/api/app/customers/${customerId}/notes`).set("x-csrf-token", csrf).send({ body: "Requested a callback tomorrow." });
    expect(secondRes.status).toBe(201);

    const listRes = await agent.get(`/api/app/customers/${customerId}/notes`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.notes).toHaveLength(2);
    expect(listRes.body.notes[0].body).toBe("Requested a callback tomorrow.");
    expect(listRes.body.notes[1].body).toBe("Called to confirm address.");
  });

  it("rejects an empty note body with 400", async () => {
    await seedUser("notes-admin2@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "notes-admin2@example.com");
    const customerRes = await agent
      .post("/api/app/customers")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Note", lastName: "Subject", email: "note-subject2@example.com", leadReceivedDate: "2026-08-15" });
    const customerId = customerRes.body.customer.id;

    const res = await agent.post(`/api/app/customers/${customerId}/notes`).set("x-csrf-token", csrf).send({ body: "" });
    expect(res.status).toBe(400);
  });

  it("404s adding a note for a customer that doesn't exist", async () => {
    await seedUser("notes-admin3@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "notes-admin3@example.com");
    const res = await agent
      .post("/api/app/customers/00000000-0000-0000-0000-000000000000/notes")
      .set("x-csrf-token", csrf)
      .send({ body: "Should not land anywhere." });
    expect(res.status).toBe(404);
  });

  it("manager can read notes but not add one — same read-only treatment as the rest of Leads/Orders", async () => {
    await seedUser("notes-admin4@example.com", "admin");
    const admin = await loginAgent(app, "notes-admin4@example.com");
    const customerRes = await admin.agent
      .post("/api/app/customers")
      .set("x-csrf-token", admin.csrf)
      .send({ firstName: "Note", lastName: "Subject", email: "note-subject4@example.com", leadReceivedDate: "2026-08-15" });
    const customerId = customerRes.body.customer.id;
    await admin.agent.post(`/api/app/customers/${customerId}/notes`).set("x-csrf-token", admin.csrf).send({ body: "Admin-authored note." });

    await seedUser("notes-mgr1@example.com", "manager");
    const manager = await loginAgent(app, "notes-mgr1@example.com");
    const listRes = await manager.agent.get(`/api/app/customers/${customerId}/notes`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.notes).toHaveLength(1);

    const addRes = await manager.agent.post(`/api/app/customers/${customerId}/notes`).set("x-csrf-token", manager.csrf).send({ body: "Manager should not be able to add this." });
    expect(addRes.status).toBe(403);
  });

  it("rejects unauthenticated requests to both endpoints", async () => {
    const anyId = "00000000-0000-0000-0000-000000000000";
    expect((await request(app).get(`/api/app/customers/${anyId}/notes`)).status).toBe(401);
    expect((await request(app).post(`/api/app/customers/${anyId}/notes`).send({ body: "x" })).status).toBe(401);
  });

  it("customer_service can both read and add notes — this is who actually takes the call/text and logs it", async () => {
    await seedUser("notes-admin5@example.com", "admin");
    const admin = await loginAgent(app, "notes-admin5@example.com");
    const customerRes = await admin.agent
      .post("/api/app/customers")
      .set("x-csrf-token", admin.csrf)
      .send({ firstName: "Note", lastName: "Subject", email: "note-subject5@example.com", leadReceivedDate: "2026-08-15" });
    const customerId = customerRes.body.customer.id;

    await seedUser("notes-cs1@example.com", "customer_service");
    const cs = await loginAgent(app, "notes-cs1@example.com");
    const addRes = await cs.agent
      .post(`/api/app/customers/${customerId}/notes`)
      .set("x-csrf-token", cs.csrf)
      .send({ body: "Called the customer, confirmed shipping address." });
    expect(addRes.status).toBe(201);
    expect(addRes.body.note).toMatchObject({ customerId, authorEmail: "notes-cs1@example.com" });

    const listRes = await cs.agent.get(`/api/app/customers/${customerId}/notes`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.notes).toHaveLength(1);
  });
});
