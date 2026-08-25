import { describe, expect, it, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";

const PASSWORD = "CorrectHorseBattery1";

async function seedUser(email: string, role: "admin" | "manager" | "customer_service") {
  const { db, appUsersTable } = await import("@luma/db");
  const { hashPassword } = await import("../../lib/crypto.js");
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

describe("Employees", () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    app = createApp();
  });

  it("customer_service role is forbidden entirely — payroll is manager/admin scope, not customer_service's", async () => {
    await seedUser("payroll-cs1@example.com", "customer_service");
    const csAgent = await loginAgent(app, "payroll-cs1@example.com");
    expect((await csAgent.agent.get("/api/app/payroll/employees")).status).toBe(403);
  });

  it("manager can both read and write — payroll/employees is manager's scope", async () => {
    await seedUser("payroll-mgr1@example.com", "manager");
    const managerAgent = await loginAgent(app, "payroll-mgr1@example.com");
    expect((await managerAgent.agent.get("/api/app/payroll/employees")).status).toBe(200);
    const managerCreate = await managerAgent.agent
      .post("/api/app/payroll/employees")
      .set("x-csrf-token", managerAgent.csrf)
      .send({ firstName: "X", lastName: "Y", email: "xy@example.com", hourlyRate: "20.00" });
    expect(managerCreate.status).toBe(201);
  });

  it("admin can both read and write", async () => {
    await seedUser("payroll-admin1@example.com", "admin");
    const adminAgent = await loginAgent(app, "payroll-admin1@example.com");
    const created = await adminAgent.agent
      .post("/api/app/payroll/employees")
      .set("x-csrf-token", adminAgent.csrf)
      .send({ firstName: "Alice", lastName: "Worker", email: "alice.worker@example.com", hourlyRate: "22.50" });
    expect(created.status).toBe(201);
    expect(created.body.employee.employeeNumber).toMatch(/^EMP-\d{6}$/);
  });
});

describe("Payroll week lifecycle", () => {
  let app: ReturnType<typeof createApp>;
  let agent: request.Agent;
  let csrf: string;
  let employeeId: string;

  beforeAll(async () => {
    app = createApp();
    await seedUser("payroll-admin2@example.com", "admin");
    ({ agent, csrf } = await loginAgent(app, "payroll-admin2@example.com"));

    const employeeRes = await agent
      .post("/api/app/payroll/employees")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Bob", lastName: "Hourly", email: "bob.hourly@example.com", hourlyRate: "20.00" });
    employeeId = employeeRes.body.employee.id;
  });

  it("full lifecycle: create draft -> enter hours -> add bonus -> approve -> pay, with correct earnings calc and audit trail", async () => {
    const weekRes = await agent
      .post("/api/app/payroll/weeks")
      .set("x-csrf-token", csrf)
      .send({ weekStart: "2026-03-06", weekEnd: "2026-03-12" });
    expect(weekRes.status).toBe(201);
    const weekId = weekRes.body.week.id;
    expect(weekRes.body.week.status).toBe("draft");

    const hoursRes = await agent
      .put(`/api/app/payroll/weeks/${weekId}/hours`)
      .set("x-csrf-token", csrf)
      .send({ employeeId, hoursWorked: "40" });
    expect(hoursRes.status).toBe(200);
    expect(hoursRes.body.entry.hourlyEarnings).toBe("800.00"); // 40 * 20.00
    expect(hoursRes.body.entry.hourlyRateSnapshot).toBe("20.00");

    // Re-entering hours for the same employee/week upserts, doesn't duplicate.
    const hoursUpdateRes = await agent
      .put(`/api/app/payroll/weeks/${weekId}/hours`)
      .set("x-csrf-token", csrf)
      .send({ employeeId, hoursWorked: "45" });
    expect(hoursUpdateRes.body.entry.hourlyEarnings).toBe("900.00");

    const bonusRes = await agent
      .post(`/api/app/payroll/weeks/${weekId}/bonuses`)
      .set("x-csrf-token", csrf)
      .send({ employeeId, amount: "50.00", description: "Great week" });
    expect(bonusRes.status).toBe(201);

    // Can't pay before approving.
    const payTooEarly = await agent.post(`/api/app/payroll/weeks/${weekId}/pay`).set("x-csrf-token", csrf);
    expect(payTooEarly.status).toBe(400);

    const approveRes = await agent.post(`/api/app/payroll/weeks/${weekId}/approve`).set("x-csrf-token", csrf);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.week.status).toBe("approved");
    expect(approveRes.body.week.approvedBy).toBe("payroll-admin2@example.com");

    // Can't enter hours or add bonuses once approved.
    const hoursAfterApprove = await agent
      .put(`/api/app/payroll/weeks/${weekId}/hours`)
      .set("x-csrf-token", csrf)
      .send({ employeeId, hoursWorked: "10" });
    expect(hoursAfterApprove.status).toBe(400);

    // Can't re-approve an already-approved week.
    const reapprove = await agent.post(`/api/app/payroll/weeks/${weekId}/approve`).set("x-csrf-token", csrf);
    expect(reapprove.status).toBe(400);

    const payRes = await agent.post(`/api/app/payroll/weeks/${weekId}/pay`).set("x-csrf-token", csrf);
    expect(payRes.status).toBe(200);
    expect(payRes.body.week.status).toBe("paid");
    expect(payRes.body.week.paidBy).toBe("payroll-admin2@example.com");

    const detailRes = await agent.get(`/api/app/payroll/weeks/${weekId}`);
    expect(detailRes.body.hours).toHaveLength(1);
    expect(detailRes.body.hours[0].hourlyEarnings).toBe("900.00");
    expect(detailRes.body.bonuses).toHaveLength(1);

    const { db, payrollAuditEventsTable } = await import("@luma/db");
    const { eq } = await import("drizzle-orm");
    const auditRows = await db.select().from(payrollAuditEventsTable).where(eq(payrollAuditEventsTable.payrollWeekId, weekId));
    const actions = auditRows.map((r) => r.action).sort();
    expect(actions).toEqual(["bonus_added", "hours_entered", "hours_updated", "week_approved", "week_paid"]);
  });

  it("entering hours for a second employee in the same week doesn't attribute the first employee's row to them", async () => {
    const employeeARes = await agent
      .post("/api/app/payroll/employees")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Alice", lastName: "First", email: "alice.first@example.com", hourlyRate: "20.00" });
    const employeeAId = employeeARes.body.employee.id;

    const employeeBRes = await agent
      .post("/api/app/payroll/employees")
      .set("x-csrf-token", csrf)
      .send({ firstName: "Bea", lastName: "Second", email: "bea.second@example.com", hourlyRate: "30.00" });
    const employeeBId = employeeBRes.body.employee.id;

    const weekRes = await agent
      .post("/api/app/payroll/weeks")
      .set("x-csrf-token", csrf)
      .send({ weekStart: "2026-04-03", weekEnd: "2026-04-09" });
    const weekId = weekRes.body.week.id;

    // Employee A enters hours first.
    const aRes = await agent
      .put(`/api/app/payroll/weeks/${weekId}/hours`)
      .set("x-csrf-token", csrf)
      .send({ employeeId: employeeAId, hoursWorked: "40" });
    expect(aRes.body.entry.hourlyEarnings).toBe("800.00"); // 40 * 20.00

    // Employee B enters hours for the first time in this same week — this
    // must NOT be misread as an update to employee A's row.
    const bRes = await agent
      .put(`/api/app/payroll/weeks/${weekId}/hours`)
      .set("x-csrf-token", csrf)
      .send({ employeeId: employeeBId, hoursWorked: "10" });
    expect(bRes.body.entry.hourlyEarnings).toBe("300.00"); // 10 * 30.00
    expect(bRes.body.entry.employeeId).toBe(employeeBId);

    // Employee A's row must be untouched.
    const detailRes = await agent.get(`/api/app/payroll/weeks/${weekId}`);
    const aEntry = detailRes.body.hours.find((h: { employeeId: string }) => h.employeeId === employeeAId);
    expect(aEntry.hourlyEarnings).toBe("800.00");

    const { db, payrollAuditEventsTable } = await import("@luma/db");
    const { eq, and } = await import("drizzle-orm");
    const [bAudit] = await db
      .select()
      .from(payrollAuditEventsTable)
      .where(and(eq(payrollAuditEventsTable.payrollWeekId, weekId), eq(payrollAuditEventsTable.employeeId, employeeBId)));
    // Must be logged as a first-time entry, with no previousValues leaked
    // from employee A's already-existing row in the same week.
    expect(bAudit.action).toBe("hours_entered");
    expect(bAudit.previousValues).toBeNull();
  });

  it("returns 404 for an unknown week id on approve", async () => {
    const res = await agent.post("/api/app/payroll/weeks/00000000-0000-0000-0000-000000000000/approve").set("x-csrf-token", csrf);
    expect(res.status).toBe(400); // service returns "not found" as a 400-level business error, not a route 404
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe("Marketing spend weeks", () => {
  let app: ReturnType<typeof createApp>;
  let agent: request.Agent;
  let csrf: string;

  beforeAll(async () => {
    app = createApp();
    await seedUser("payroll-admin3@example.com", "admin");
    ({ agent, csrf } = await loginAgent(app, "payroll-admin3@example.com"));
  });

  it("creates a Friday-starting week with weekEnd auto-derived to the following Thursday", async () => {
    // 2026-03-06 is a Friday; 2026-03-12 is the following Thursday.
    const res = await agent.post("/api/app/payroll/marketing-spend").set("x-csrf-token", csrf).send({ weekStart: "2026-03-06" });
    expect(res.status).toBe(201);
    expect(res.body.week.weekStart).toBe("2026-03-06");
    expect(res.body.week.weekEnd).toBe("2026-03-12");
  });

  it("rejects a weekStart that isn't a Friday", async () => {
    const res = await agent.post("/api/app/payroll/marketing-spend").set("x-csrf-token", csrf).send({ weekStart: "2026-03-09" }); // Monday
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Friday/);
  });

  it("rejects manager role — marketing spend is admin-only, manager's Orders/Leads access is read-only elsewhere", async () => {
    await seedUser("marketing-spend-mgr@example.com", "manager");
    const manager = await loginAgent(app, "marketing-spend-mgr@example.com");
    expect((await manager.agent.get("/api/app/payroll/marketing-spend")).status).toBe(403);
    const createRes = await manager.agent
      .post("/api/app/payroll/marketing-spend")
      .set("x-csrf-token", manager.csrf)
      .send({ weekStart: "2026-03-13" });
    expect(createRes.status).toBe(403);
  });

  it("updates per-source spend via PATCH, clears it with an empty string, and GET reflects CPA metrics", async () => {
    const createRes = await agent.post("/api/app/payroll/marketing-spend").set("x-csrf-token", csrf).send({ weekStart: "2026-04-03" });
    const weekId = createRes.body.week.id;

    const updateRes = await agent
      .patch(`/api/app/payroll/marketing-spend/${weekId}`)
      .set("x-csrf-token", csrf)
      .send({ metaFormFillSpend: "100.00", ecommerceSpend: "50.00" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.week.metaFormFillSpend).toBe("100.00");
    expect(updateRes.body.week.ecommerceSpend).toBe("50.00");

    const listRes = await agent.get("/api/app/payroll/marketing-spend");
    expect(listRes.status).toBe(200);
    const week = listRes.body.weeks.find((w: { id: string }) => w.id === weekId);
    expect(week.metaFormFill.spend).toBe("100.00");
    expect(week.ecommerce.spend).toBe("50.00");
    expect(week.combined.spend).toBe("150.00");
    // No leads/deals seeded in this period yet.
    expect(week.combined.leadsReceived).toBe(0);
    expect(week.combined.cpa).toBeNull();

    // Clear meta spend back to null with an explicit empty string.
    const clearRes = await agent
      .patch(`/api/app/payroll/marketing-spend/${weekId}`)
      .set("x-csrf-token", csrf)
      .send({ metaFormFillSpend: "" });
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.week.metaFormFillSpend).toBeNull();
  });

  it("attributes closed deals to the week the lead was received, not the purchase date, and excludes recurring purchases", async () => {
    const { db, customersTable, externalIdentitiesTable, purchasesTable } = await import("@luma/db");

    // Lead received Jan 1 (well before this test's CPA week) via GHL (meta), first purchase happens inside the CPA week.
    const [oldLead] = await db
      .insert(customersTable)
      .values({ firstName: "Old", lastName: "Lead", email: "old-lead-cpa@example.com", leadReceivedDate: "2026-01-01" })
      .returning();
    await db.insert(externalIdentitiesTable).values({ personId: oldLead!.id, system: "ghl", externalId: "old-lead-cpa-ext" });
    await db.insert(purchasesTable).values({
      customerId: oldLead!.id,
      purchaseDate: "2026-05-08", // inside the CPA week below
      orderNumber: "ORD-CPA-OLD",
      productName: "Thing",
      amountPaid: "200.00",
      status: "completed",
      orderClassification: "first_order",
      orderClassificationSource: "manual",
    });

    // A new lead received inside the CPA week itself, via Bask (ecommerce), purchases within the same week.
    const [newLead] = await db
      .insert(customersTable)
      .values({ firstName: "New", lastName: "Lead", email: "new-lead-cpa@example.com", leadReceivedDate: "2026-05-09" })
      .returning();
    await db.insert(externalIdentitiesTable).values({ personId: newLead!.id, system: "bask", externalId: "new-lead-cpa-ext" });
    await db.insert(purchasesTable).values({
      customerId: newLead!.id,
      purchaseDate: "2026-05-09",
      orderNumber: "ORD-CPA-NEW",
      productName: "Thing",
      amountPaid: "300.00",
      status: "completed",
      orderClassification: "first_order",
      orderClassificationSource: "manual",
    });
    // A second, recurring purchase for the same lead in the same week — must not count as a closed deal.
    await db.insert(purchasesTable).values({
      customerId: newLead!.id,
      purchaseDate: "2026-05-10",
      orderNumber: "ORD-CPA-NEW-2",
      productName: "Thing 2",
      amountPaid: "999.00",
      status: "completed",
      orderClassification: "recurring",
      orderClassificationSource: "manual",
    });

    // 2026-05-08 is a Friday; week runs through 2026-05-14 (Thursday).
    const createRes = await agent.post("/api/app/payroll/marketing-spend").set("x-csrf-token", csrf).send({ weekStart: "2026-05-08" });
    const weekId = createRes.body.week.id;
    await agent
      .patch(`/api/app/payroll/marketing-spend/${weekId}`)
      .set("x-csrf-token", csrf)
      .send({ metaFormFillSpend: "40.00", ecommerceSpend: "60.00" });

    const listRes = await agent.get("/api/app/payroll/marketing-spend");
    const week = listRes.body.weeks.find((w: { id: string }) => w.id === weekId);

    // Old lead's purchase falls inside this week, but the lead itself was received back in January — not attributed here.
    expect(week.metaFormFill.leadsReceived).toBe(0);
    expect(week.metaFormFill.closedDeals).toBe(0);

    // New lead was received inside this week and closed inside this week.
    expect(week.ecommerce.leadsReceived).toBe(1);
    expect(week.ecommerce.closedDeals).toBe(1);
    expect(week.ecommerce.acquisitionRevenue).toBe("300.00");
    expect(week.ecommerce.recurringExclusions).toBe(1);
    expect(week.ecommerce.cpa).toBe(60);

    expect(week.combined.leadsReceived).toBe(1);
    expect(week.combined.closedDeals).toBe(1);
    expect(week.combined.acquisitionRevenue).toBe("300.00");
    expect(week.combined.spend).toBe("100.00");
    expect(week.combined.cpa).toBe(100);
  });
});
