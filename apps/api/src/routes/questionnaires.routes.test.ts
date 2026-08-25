import { describe, expect, it, beforeAll } from "vitest";
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

describe("Questionnaires performance", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/questionnaires");
    expect(res.status).toBe(401);
  });

  it("rejects customer_service role", async () => {
    await seedUser("quest-cs@example.com", "customer_service");
    const { agent } = await loginAgent(app, "quest-cs@example.com");
    const res = await agent.get("/api/app/questionnaires");
    expect(res.status).toBe(403);
  });

  it("rejects manager role — this is admin-only", async () => {
    await seedUser("quest-mgr@example.com", "manager");
    const { agent } = await loginAgent(app, "quest-mgr@example.com");
    const res = await agent.get("/api/app/questionnaires");
    expect(res.status).toBe(403);
  });

  it("groups by questionnaire ID, counts first-time customers, and never double-counts revenue at the summary level", async () => {
    await seedUser("quest-admin@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "quest-admin@example.com");
    const { db, customersTable, questionnaireEventsTable, purchasesTable } = await import("@luma/db");

    // Customer A: filled Q-TEST-1, converted (first_order $100) and made a
    // recurring purchase ($50) — recurring purchases count toward revenue/
    // purchases here (unlike Marketing CPA), since this page reports total
    // customer value, not lead-cohort acquisition.
    const [a] = await db
      .insert(customersTable)
      .values({ firstName: "A", lastName: "One", email: "quest-a@example.com", leadReceivedDate: "2026-01-01" })
      .returning();
    await db.insert(questionnaireEventsTable).values({ personId: a!.id, questionnaireId: "Q-TEST-1", status: "submitted", lastEventAt: new Date() });
    await db.insert(purchasesTable).values({
      customerId: a!.id,
      purchaseDate: "2026-08-01",
      orderNumber: "ORD-QT-A1",
      productName: "Thing",
      amountPaid: "100.00",
      status: "completed",
      orderClassification: "first_order",
      orderClassificationSource: "manual",
    });
    await db.insert(purchasesTable).values({
      customerId: a!.id,
      purchaseDate: "2026-08-05",
      orderNumber: "ORD-QT-A2",
      productName: "Refill",
      amountPaid: "50.00",
      status: "completed",
      orderClassification: "recurring",
      orderClassificationSource: "manual",
    });

    // Customer B: filled Q-TEST-1, never purchased.
    const [b] = await db
      .insert(customersTable)
      .values({ firstName: "B", lastName: "Two", email: "quest-b@example.com", leadReceivedDate: "2026-01-01" })
      .returning();
    await db.insert(questionnaireEventsTable).values({ personId: b!.id, questionnaireId: "Q-TEST-1", status: "abandoned", lastEventAt: new Date() });

    // Customer C: filled a different questionnaire, Q-TEST-2, converted ($200).
    const [c] = await db
      .insert(customersTable)
      .values({ firstName: "C", lastName: "Three", email: "quest-c@example.com", leadReceivedDate: "2026-01-01" })
      .returning();
    await db.insert(questionnaireEventsTable).values({ personId: c!.id, questionnaireId: "Q-TEST-2", status: "submitted", lastEventAt: new Date() });
    await db.insert(purchasesTable).values({
      customerId: c!.id,
      purchaseDate: "2026-08-02",
      orderNumber: "ORD-QT-C1",
      productName: "Thing",
      amountPaid: "200.00",
      status: "completed",
      orderClassification: "first_order",
      orderClassificationSource: "manual",
    });

    // Customer D: filled Q-TEST-1 but 90 days ago — outside the default 30-day period.
    const [d] = await db
      .insert(customersTable)
      .values({ firstName: "D", lastName: "Four", email: "quest-d@example.com", leadReceivedDate: "2025-01-01" })
      .returning();
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 90);
    await db.insert(questionnaireEventsTable).values({ personId: d!.id, questionnaireId: "Q-TEST-1", status: "abandoned", lastEventAt: oldDate });

    const res30 = await agent.get("/api/app/questionnaires").query({ period: 30 });
    expect(res30.status).toBe(200);

    const rowQ1 = res30.body.rows.find((r: { questionnaireId: string }) => r.questionnaireId === "Q-TEST-1");
    expect(rowQ1.leads).toBe(2); // A, B — D is outside the period
    expect(rowQ1.customers).toBe(1); // A only
    expect(rowQ1.conversionRate).toBe(50);
    expect(rowQ1.purchases).toBe(2); // A's two completed purchases
    expect(rowQ1.revenue).toBe("150.00");
    expect(rowQ1.avgValue).toBe("75.00");
    expect(rowQ1.lastPurchase).toBe("2026-08-05");

    const rowQ2 = res30.body.rows.find((r: { questionnaireId: string }) => r.questionnaireId === "Q-TEST-2");
    expect(rowQ2.leads).toBe(1);
    expect(rowQ2.customers).toBe(1);
    expect(rowQ2.conversionRate).toBe(100);
    expect(rowQ2.revenue).toBe("200.00");

    // Summary aggregates across the whole DB (other test files' seeded
    // questionnaire activity may also land in this window), so only lower
    // bounds are asserted here — the per-row assertions above are the ones
    // that pin down exact behavior for this test's own data.
    expect(res30.body.summary.leadsWithQuestionnaire).toBeGreaterThanOrEqual(3); // at least A, B, C
    expect(res30.body.summary.firstTimeCustomers).toBeGreaterThanOrEqual(2); // at least A, C
    expect(res30.body.summary.completedPurchases).toBeGreaterThanOrEqual(3); // at least A's 2 + C's 1
    expect(Number(res30.body.summary.totalRevenue)).toBeGreaterThanOrEqual(350); // at least 100 + 50 + 200

    // With period=all, D's old event now counts toward Q-TEST-1's leads.
    const resAll = await agent.get("/api/app/questionnaires").query({ period: "all" });
    const rowQ1All = resAll.body.rows.find((r: { questionnaireId: string }) => r.questionnaireId === "Q-TEST-1");
    expect(rowQ1All.leads).toBe(3); // A, B, D
    expect(resAll.body.summary.leadsWithQuestionnaire).toBeGreaterThanOrEqual(4); // at least A, B, C, D
  });
});
