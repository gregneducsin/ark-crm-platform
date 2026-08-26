import { describe, expect, it, beforeAll, vi } from "vitest";
import request from "supertest";

const sendEmailMock = vi.fn().mockResolvedValue({ messageId: "<invite@example.com>" });
vi.mock("../lib/email-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/email-provider.js")>("../lib/email-provider.js");
  return { ...actual, getEmailProvider: () => ({ provider: { sendEmail: sendEmailMock }, fromName: "Ark Health" }) };
});

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

describe("Users", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/users");
    expect(res.status).toBe(401);
  });

  it("rejects manager and customer_service roles — user management is admin-only", async () => {
    const target = await seedUser("users-mgr@example.com", "manager");
    const manager = await loginAgent(app, "users-mgr@example.com");
    expect((await manager.agent.get("/api/app/users")).status).toBe(403);
    expect(
      (await manager.agent.patch(`/api/app/users/${target.id}`).set("x-csrf-token", manager.csrf).send({ role: "admin" })).status,
    ).toBe(403);

    await seedUser("users-cs@example.com", "customer_service");
    const cs = await loginAgent(app, "users-cs@example.com");
    expect((await cs.agent.get("/api/app/users")).status).toBe(403);
    expect(
      (await cs.agent.patch(`/api/app/users/${target.id}`).set("x-csrf-token", cs.csrf).send({ role: "admin" })).status,
    ).toBe(403);
  });

  it("admin invites a new user: creates the row, sends the invite email, and lists it", async () => {
    sendEmailMock.mockClear();
    await seedUser("users-admin1@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "users-admin1@example.com");

    const res = await agent
      .post("/api/app/users")
      .set("x-csrf-token", csrf)
      .send({ email: "newhire@example.com", firstName: "New", lastName: "Hire", role: "customer_service" });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: "newhire@example.com", role: "customer_service", status: "invited" });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [to, subject, html] = sendEmailMock.mock.calls[0];
    expect(to).toBe("newhire@example.com");
    expect(subject).toMatch(/invited/i);
    expect(html).toContain("New");
    expect(html).toContain("Customer Service");

    const listRes = await agent.get("/api/app/users");
    expect(listRes.status).toBe(200);
    expect(listRes.body.users.some((u: { email: string }) => u.email === "newhire@example.com")).toBe(true);
  });

  it("rejects a duplicate email with 409", async () => {
    await seedUser("users-admin2@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "users-admin2@example.com");

    await agent
      .post("/api/app/users")
      .set("x-csrf-token", csrf)
      .send({ email: "dup@example.com", firstName: "First", lastName: "One", role: "manager" });

    const res = await agent
      .post("/api/app/users")
      .set("x-csrf-token", csrf)
      .send({ email: "dup@example.com", firstName: "Second", lastName: "One", role: "manager" });
    expect(res.status).toBe(409);
  });

  it("rejects an invalid role with 400", async () => {
    await seedUser("users-admin3@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "users-admin3@example.com");

    const res = await agent
      .post("/api/app/users")
      .set("x-csrf-token", csrf)
      .send({ email: "bad-role@example.com", firstName: "A", lastName: "B", role: "superadmin" });
    expect(res.status).toBe(400);
  });

  it("still creates the invite even when the email send fails", async () => {
    sendEmailMock.mockClear();
    sendEmailMock.mockRejectedValueOnce(new Error("SMTP down"));
    await seedUser("users-admin4@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "users-admin4@example.com");

    const res = await agent
      .post("/api/app/users")
      .set("x-csrf-token", csrf)
      .send({ email: "email-fails@example.com", firstName: "A", lastName: "B", role: "customer_service" });
    expect(res.status).toBe(201);
    expect(res.body.user.status).toBe("invited");
  });

  it("admin changes a user's role, but can't target themselves or a nonexistent user", async () => {
    const admin = await seedUser("users-admin5@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "users-admin5@example.com");
    const target = await seedUser("users-target1@example.com", "customer_service");

    const roleRes = await agent.patch(`/api/app/users/${target.id}`).set("x-csrf-token", csrf).send({ role: "manager" });
    expect(roleRes.status).toBe(200);
    expect(roleRes.body.user.role).toBe("manager");

    const selfRes = await agent.patch(`/api/app/users/${admin.id}`).set("x-csrf-token", csrf).send({ role: "manager" });
    expect(selfRes.status).toBe(400);

    const missingRes = await agent
      .patch("/api/app/users/00000000-0000-0000-0000-000000000000")
      .set("x-csrf-token", csrf)
      .send({ role: "manager" });
    expect(missingRes.status).toBe(404);
  });

  it("disabling a user revokes their existing session immediately; reactivating lets them log in again", async () => {
    await seedUser("users-target2@example.com", "customer_service");
    const target = await loginAgent(app, "users-target2@example.com");
    expect((await target.agent.get("/api/app/conversations")).status).toBe(200);

    await seedUser("users-admin6@example.com", "admin");
    const admin = await loginAgent(app, "users-admin6@example.com");
    const { db, appUsersTable } = await import("@luma/db");
    const { eq } = await import("drizzle-orm");
    const [targetUser] = await db.select().from(appUsersTable).where(eq(appUsersTable.normalizedEmail, "users-target2@example.com"));

    const disableRes = await admin.agent
      .patch(`/api/app/users/${targetUser!.id}`)
      .set("x-csrf-token", admin.csrf)
      .send({ status: "disabled" });
    expect(disableRes.status).toBe(200);
    expect(disableRes.body.user.status).toBe("disabled");

    // Same session cookie, but the session row was revoked server-side.
    expect((await target.agent.get("/api/app/conversations")).status).toBe(401);

    const reactivateRes = await admin.agent
      .patch(`/api/app/users/${targetUser!.id}`)
      .set("x-csrf-token", admin.csrf)
      .send({ status: "active" });
    expect(reactivateRes.status).toBe(200);
    expect(reactivateRes.body.user.status).toBe("active");
  });

  describe("POST /:id/resend-invite", () => {
  // A fresh app instance here means a fresh, independent authLimiter budget
  // (limit: 10 per window) — the outer describe's tests already use all 10
  // of the shared app's logins, so reusing it here would flake on rate
  // limiting rather than the actual behavior under test.
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    app = createApp();
  });

  it("re-sends the invitation email for a user still stuck as invited", async () => {
    await seedUser("resend-admin1@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "resend-admin1@example.com");

    const inviteRes = await agent
      .post("/api/app/users")
      .set("x-csrf-token", csrf)
      .send({ email: "resend-target1@example.com", firstName: "Res", lastName: "End", role: "customer_service" });
    const targetId = inviteRes.body.user.id as string;

    sendEmailMock.mockClear();
    const res = await agent.post(`/api/app/users/${targetId}/resend-invite`).set("x-csrf-token", csrf).send();
    expect(res.status).toBe(200);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [to, subject] = sendEmailMock.mock.calls[0];
    expect(to).toBe("resend-target1@example.com");
    expect(subject).toMatch(/invited/i);
  });

  it("rejects a user who has already accepted their invitation", async () => {
    await seedUser("resend-admin2@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "resend-admin2@example.com");
    const target = await seedUser("resend-active1@example.com", "customer_service");

    const res = await agent.post(`/api/app/users/${target.id}/resend-invite`).set("x-csrf-token", csrf).send();
    expect(res.status).toBe(400);
  });

  it("404s for a nonexistent user", async () => {
    await seedUser("resend-admin3@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "resend-admin3@example.com");

    const res = await agent
      .post("/api/app/users/00000000-0000-0000-0000-000000000000/resend-invite")
      .set("x-csrf-token", csrf)
      .send();
    expect(res.status).toBe(404);
  });

  it("rejects manager and customer_service roles", async () => {
    const target = await seedUser("resend-target2@example.com", "customer_service");
    await seedUser("resend-mgr@example.com", "manager");
    const manager = await loginAgent(app, "resend-mgr@example.com");
    const res = await manager.agent.post(`/api/app/users/${target.id}/resend-invite`).set("x-csrf-token", manager.csrf).send();
    expect(res.status).toBe(403);
  });
});

describe("POST /:id/reset-password", () => {
  // Same reasoning as the resend-invite describe above: a fresh app instance
  // gets its own independent authLimiter budget instead of sharing the
  // outer describe's already-exhausted one.
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    app = createApp();
  });

  it("emails a reset link directly to an active user", async () => {
    await seedUser("reset-admin1@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "reset-admin1@example.com");
    const target = await seedUser("reset-target1@example.com", "customer_service");

    sendEmailMock.mockClear();
    const res = await agent.post(`/api/app/users/${target.id}/reset-password`).set("x-csrf-token", csrf).send();
    expect(res.status).toBe(200);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [to, subject, html] = sendEmailMock.mock.calls[0];
    expect(to).toBe("reset-target1@example.com");
    expect(subject).toMatch(/reset/i);
    expect(html).toContain("/reset-password?token=");
  });

  it("works for a locked user (gives them a way back in)", async () => {
    await seedUser("reset-admin2@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "reset-admin2@example.com");
    const target = await seedUser("reset-locked1@example.com", "customer_service");
    const { db, appUsersTable } = await import("@luma/db");
    const { eq } = await import("drizzle-orm");
    await db.update(appUsersTable).set({ status: "locked" }).where(eq(appUsersTable.id, target.id));

    sendEmailMock.mockClear();
    const res = await agent.post(`/api/app/users/${target.id}/reset-password`).set("x-csrf-token", csrf).send();
    expect(res.status).toBe(200);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a user who hasn't accepted their invitation yet", async () => {
    await seedUser("reset-admin3@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "reset-admin3@example.com");

    const inviteRes = await agent
      .post("/api/app/users")
      .set("x-csrf-token", csrf)
      .send({ email: "reset-invited1@example.com", firstName: "A", lastName: "B", role: "customer_service" });
    const targetId = inviteRes.body.user.id as string;

    const res = await agent.post(`/api/app/users/${targetId}/reset-password`).set("x-csrf-token", csrf).send();
    expect(res.status).toBe(400);
  });

  it("404s for a nonexistent user", async () => {
    await seedUser("reset-admin4@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "reset-admin4@example.com");

    const res = await agent
      .post("/api/app/users/00000000-0000-0000-0000-000000000000/reset-password")
      .set("x-csrf-token", csrf)
      .send();
    expect(res.status).toBe(404);
  });

  it("rejects manager and customer_service roles", async () => {
    const target = await seedUser("reset-target2@example.com", "customer_service");
    await seedUser("reset-cs@example.com", "customer_service");
    const cs = await loginAgent(app, "reset-cs@example.com");
    const res = await cs.agent.post(`/api/app/users/${target.id}/reset-password`).set("x-csrf-token", cs.csrf).send();
    expect(res.status).toBe(403);
  });
  });
});
