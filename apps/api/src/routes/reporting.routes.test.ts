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

describe("GET /api/app/reporting/funnel", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/reporting/funnel");
    expect(res.status).toBe(401);
  });

  it("allows admin and manager, matching /api/app/customers' own gate", async () => {
    await seedUser("reporting-admin1@example.com", "admin");
    const admin = await loginAgent(app, "reporting-admin1@example.com");
    expect((await admin.agent.get("/api/app/reporting/funnel")).status).toBe(200);

    await seedUser("reporting-mgr1@example.com", "manager");
    const manager = await loginAgent(app, "reporting-mgr1@example.com");
    expect((await manager.agent.get("/api/app/reporting/funnel")).status).toBe(200);
  });

  it("rejects customer_service", async () => {
    await seedUser("reporting-cs1@example.com", "customer_service");
    const cs = await loginAgent(app, "reporting-cs1@example.com");
    expect((await cs.agent.get("/api/app/reporting/funnel")).status).toBe(403);
  });

  it("accepts a valid from/to range", async () => {
    await seedUser("reporting-admin2@example.com", "admin");
    const admin = await loginAgent(app, "reporting-admin2@example.com");
    const res = await admin.agent.get("/api/app/reporting/funnel").query({ from: "2026-01-01", to: "2026-01-31" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalLeads: expect.any(Number), revenue: expect.any(Number) });
  });

  it("rejects a malformed date with 400", async () => {
    await seedUser("reporting-admin3@example.com", "admin");
    const admin = await loginAgent(app, "reporting-admin3@example.com");
    const res = await admin.agent.get("/api/app/reporting/funnel").query({ from: "not-a-date", to: "2026-01-31" });
    expect(res.status).toBe(400);
  });
});
