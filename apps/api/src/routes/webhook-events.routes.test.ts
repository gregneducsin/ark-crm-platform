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

async function seedWebhookEvent(overrides: Record<string, unknown> = {}) {
  const { db, webhookEventsTable } = await import("@luma/db");
  const [row] = await db
    .insert(webhookEventsTable)
    .values({
      source: "bask_questionnaire",
      externalEventId: crypto.randomUUID(),
      rawPayload: { hello: "world" },
      ...overrides,
    })
    .returning({ id: webhookEventsTable.id });
  return row.id;
}

describe("GET /api/app/webhook-events", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/webhook-events");
    expect(res.status).toBe(401);
  });

  it("allows admin and manager", async () => {
    await seedUser("webhookevt-admin1@example.com", "admin");
    const admin = await loginAgent(app, "webhookevt-admin1@example.com");
    expect((await admin.agent.get("/api/app/webhook-events")).status).toBe(200);

    await seedUser("webhookevt-mgr1@example.com", "manager");
    const manager = await loginAgent(app, "webhookevt-mgr1@example.com");
    expect((await manager.agent.get("/api/app/webhook-events")).status).toBe(200);
  });

  it("rejects customer_service", async () => {
    await seedUser("webhookevt-cs1@example.com", "customer_service");
    const cs = await loginAgent(app, "webhookevt-cs1@example.com");
    expect((await cs.agent.get("/api/app/webhook-events")).status).toBe(403);
  });

  it("returns events, filterable by status and source", async () => {
    await seedUser("webhookevt-admin2@example.com", "admin");
    const { agent } = await loginAgent(app, "webhookevt-admin2@example.com");
    const failedId = await seedWebhookEvent({ status: "failed", errorMessage: "email: Invalid email", source: "bask_payment_refunded" });

    const allRes = await agent.get("/api/app/webhook-events");
    expect(allRes.body.items.some((i: { id: string }) => i.id === failedId)).toBe(true);

    const failedRes = await agent.get("/api/app/webhook-events?status=failed");
    expect(failedRes.body.items.some((i: { id: string }) => i.id === failedId)).toBe(true);

    const sourceRes = await agent.get("/api/app/webhook-events?source=bask_payment_refunded");
    expect(sourceRes.body.items.some((i: { id: string }) => i.id === failedId)).toBe(true);

    const wrongSourceRes = await agent.get("/api/app/webhook-events?source=bask_order");
    expect(wrongSourceRes.body.items.some((i: { id: string }) => i.id === failedId)).toBe(false);
  });

  it("ignores an invalid status or source query value rather than erroring", async () => {
    await seedUser("webhookevt-admin3@example.com", "admin");
    const { agent } = await loginAgent(app, "webhookevt-admin3@example.com");

    const res = await agent.get("/api/app/webhook-events?status=not-a-real-status&source=not-a-real-source");
    expect(res.status).toBe(200);
  });
});
