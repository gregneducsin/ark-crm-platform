import { describe, expect, it, beforeAll } from "vitest";
import request from "supertest";

const { createApp } = await import("../app.js");

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

async function seedFailedPayment() {
  const { db, failedPaymentEventsTable } = await import("@luma/db");
  const [row] = await db
    .insert(failedPaymentEventsTable)
    .values({
      externalEventId: crypto.randomUUID(),
      transactionId: crypto.randomUUID(),
      externalPersonId: crypto.randomUUID(),
      failureDate: new Date("2026-08-20T12:00:00Z"),
      rawPayload: {},
    })
    .returning({ id: failedPaymentEventsTable.id });
  return row.id;
}

describe("GET /api/app/failed-payments", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/failed-payments");
    expect(res.status).toBe(401);
  });

  it("allows admin and manager", async () => {
    await seedUser("failedpay-admin1@example.com", "admin");
    const admin = await loginAgent(app, "failedpay-admin1@example.com");
    expect((await admin.agent.get("/api/app/failed-payments")).status).toBe(200);

    await seedUser("failedpay-mgr1@example.com", "manager");
    const manager = await loginAgent(app, "failedpay-mgr1@example.com");
    expect((await manager.agent.get("/api/app/failed-payments")).status).toBe(200);
  });

  it("rejects customer_service", async () => {
    await seedUser("failedpay-cs1@example.com", "customer_service");
    const cs = await loginAgent(app, "failedpay-cs1@example.com");
    expect((await cs.agent.get("/api/app/failed-payments")).status).toBe(403);
  });

  it("defaults to open, and returns everything with status=all", async () => {
    await seedUser("failedpay-admin2@example.com", "admin");
    const { agent } = await loginAgent(app, "failedpay-admin2@example.com");
    const id = await seedFailedPayment();

    const openRes = await agent.get("/api/app/failed-payments");
    expect(openRes.body.items.some((i: { id: string }) => i.id === id)).toBe(true);

    const allRes = await agent.get("/api/app/failed-payments?status=all");
    expect(allRes.body.items.some((i: { id: string }) => i.id === id)).toBe(true);
  });
});

describe("POST /api/app/failed-payments/:id/resolve", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("resolves an event and it no longer shows up under status=open", async () => {
    await seedUser("failedpay-admin3@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "failedpay-admin3@example.com");
    const id = await seedFailedPayment();

    const res = await agent.post(`/api/app/failed-payments/${id}/resolve`).set("x-csrf-token", csrf).send({ notes: "Handled by phone." });
    expect(res.status).toBe(200);

    const openRes = await agent.get("/api/app/failed-payments");
    expect(openRes.body.items.some((i: { id: string }) => i.id === id)).toBe(false);

    const resolvedRes = await agent.get("/api/app/failed-payments?status=resolved");
    const match = resolvedRes.body.items.find((i: { id: string }) => i.id === id);
    expect(match).toMatchObject({ resolutionStatus: "resolved", notes: "Handled by phone." });
  });

  it("404s for a nonexistent id", async () => {
    await seedUser("failedpay-admin4@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "failedpay-admin4@example.com");

    const res = await agent.post("/api/app/failed-payments/00000000-0000-0000-0000-000000000000/resolve").set("x-csrf-token", csrf).send({});
    expect(res.status).toBe(404);
  });

  it("rejects manager and customer_service from mutating", async () => {
    const id = await seedFailedPayment();
    await seedUser("failedpay-cs2@example.com", "customer_service");
    const cs = await loginAgent(app, "failedpay-cs2@example.com");
    const res = await cs.agent.post(`/api/app/failed-payments/${id}/resolve`).set("x-csrf-token", cs.csrf).send({});
    expect(res.status).toBe(403);
  });
});

describe("POST /api/app/failed-payments/:id/reopen", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("reopens a resolved event", async () => {
    await seedUser("failedpay-admin5@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "failedpay-admin5@example.com");
    const id = await seedFailedPayment();
    await agent.post(`/api/app/failed-payments/${id}/resolve`).set("x-csrf-token", csrf).send({});

    const res = await agent.post(`/api/app/failed-payments/${id}/reopen`).set("x-csrf-token", csrf).send();
    expect(res.status).toBe(200);

    const openRes = await agent.get("/api/app/failed-payments");
    expect(openRes.body.items.some((i: { id: string }) => i.id === id)).toBe(true);
  });

  it("404s when the event isn't currently resolved", async () => {
    await seedUser("failedpay-admin6@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "failedpay-admin6@example.com");
    const id = await seedFailedPayment();

    const res = await agent.post(`/api/app/failed-payments/${id}/reopen`).set("x-csrf-token", csrf).send();
    expect(res.status).toBe(404);
  });
});
