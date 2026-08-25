import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

const PASSWORD = "CorrectHorseBattery1";

async function getCsrf(agent: ReturnType<typeof request.agent>) {
  const res = await agent.get("/api/app/auth/csrf-token");
  return res.body.csrfToken as string;
}

async function seedActiveUser(email: string, password: string) {
  const { db, appUsersTable } = await import("@luma/db");
  const { hashPassword } = await import("../lib/crypto.js");
  const [user] = await db
    .insert(appUsersTable)
    .values({
      email,
      normalizedEmail: email,
      role: "admin",
      status: "active",
      passwordHash: await hashPassword(password),
    })
    .returning();
  return user;
}

async function seedInvitedUser(email: string) {
  const { db, appUsersTable } = await import("@luma/db");
  const [user] = await db
    .insert(appUsersTable)
    .values({ email, normalizedEmail: email, role: "customer_service", status: "invited" })
    .returning();
  return user;
}

describe("GET /api/health", () => {
  it("returns 200", async () => {
    const app = createApp();
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
  });
});

describe("CSRF", () => {
  it("issues a token and rejects mutating requests without it", async () => {
    const app = createApp();
    const agent = request.agent(app);
    const csrf = await getCsrf(agent);
    expect(csrf).toBeTruthy();

    const withoutHeader = await agent
      .post("/api/app/auth/login")
      .send({ email: "nobody@example.com", password: "irrelevant" });
    expect(withoutHeader.status).toBe(403);

    const wrongHeader = await agent
      .post("/api/app/auth/login")
      .set("x-csrf-token", "not-the-real-token")
      .send({ email: "nobody@example.com", password: "irrelevant" });
    expect(wrongHeader.status).toBe(403);
  });
});

describe("POST /api/app/auth/login", () => {
  it("rejects unknown email with a generic message", async () => {
    const app = createApp();
    const agent = request.agent(app);
    const csrf = await getCsrf(agent);
    const res = await agent
      .post("/api/app/auth/login")
      .set("x-csrf-token", csrf)
      .send({ email: "no-such-user@example.com", password: "whatever12345" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid email or password.");
  });

  it("rejects a wrong password with the same generic message", async () => {
    const email = "wrongpw@example.com";
    await seedActiveUser(email, PASSWORD);
    const app = createApp();
    const agent = request.agent(app);
    const csrf = await getCsrf(agent);
    const res = await agent
      .post("/api/app/auth/login")
      .set("x-csrf-token", csrf)
      .send({ email, password: "totally-wrong-password" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid email or password.");
  });

  it("succeeds with correct credentials, sets a session cookie, and /me reflects it", async () => {
    const email = "gooduser@example.com";
    await seedActiveUser(email, PASSWORD);
    const app = createApp();
    const agent = request.agent(app);
    const csrf = await getCsrf(agent);

    const loginRes = await agent.post("/api/app/auth/login").set("x-csrf-token", csrf).send({ email, password: PASSWORD });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.email).toBe(email);
    const setCookie = [loginRes.headers["set-cookie"]].flat().filter(Boolean) as string[];
    expect(setCookie.some((c) => c.startsWith("ark_session="))).toBe(true);

    const meRes = await agent.get("/api/app/auth/me");
    expect(meRes.body.user.email).toBe(email);
  });

  it("locks the account after 5 failed attempts, rejecting even the correct password", async () => {
    const email = "lockout@example.com";
    await seedActiveUser(email, PASSWORD);
    const { db, appUsersTable } = await import("@luma/db");
    const { eq } = await import("drizzle-orm");

    const app = createApp();
    const agent = request.agent(app);
    const csrf = await getCsrf(agent);

    for (let i = 0; i < 5; i++) {
      const res = await agent.post("/api/app/auth/login").set("x-csrf-token", csrf).send({ email, password: "wrong" });
      expect(res.status).toBe(401);
    }

    const lockedRes = await agent.post("/api/app/auth/login").set("x-csrf-token", csrf).send({ email, password: PASSWORD });
    expect(lockedRes.status).toBe(401);

    const [row] = await db.select().from(appUsersTable).where(eq(appUsersTable.normalizedEmail, email));
    expect(row.status).toBe("locked");
    expect(row.failedLoginAttempts).toBe(5);
  });
});

describe("POST /api/app/auth/logout", () => {
  it("revokes the session server-side — /me returns null afterward", async () => {
    const email = "logout@example.com";
    await seedActiveUser(email, PASSWORD);
    const app = createApp();
    const agent = request.agent(app);
    const csrf = await getCsrf(agent);
    await agent.post("/api/app/auth/login").set("x-csrf-token", csrf).send({ email, password: PASSWORD });

    const meBefore = await agent.get("/api/app/auth/me");
    expect(meBefore.body.user).not.toBeNull();

    const logoutRes = await agent.post("/api/app/auth/logout").set("x-csrf-token", csrf);
    expect(logoutRes.status).toBe(200);

    const meAfter = await agent.get("/api/app/auth/me");
    expect(meAfter.body.user).toBeNull();
  });
});

describe("Invitation redemption", () => {
  it("accepts a valid invitation token, activates the account, and rejects reuse", async () => {
    const email = "invitee@example.com";
    const user = await seedInvitedUser(email);
    const { createInvitation } = await import("../services/auth.service.js");
    const { rawToken } = await createInvitation(user!.id);

    const app = createApp();
    const agent = request.agent(app);
    const csrf = await getCsrf(agent);

    const tooShort = await agent
      .post("/api/app/auth/accept-invitation")
      .set("x-csrf-token", csrf)
      .send({ token: rawToken, password: "short" });
    expect(tooShort.status).toBe(400);

    const accept = await agent
      .post("/api/app/auth/accept-invitation")
      .set("x-csrf-token", csrf)
      .send({ token: rawToken, password: PASSWORD });
    expect(accept.status).toBe(200);
    expect(accept.body.ok).toBe(true);

    const loginRes = await agent.post("/api/app/auth/login").set("x-csrf-token", csrf).send({ email, password: PASSWORD });
    expect(loginRes.status).toBe(200);

    const reuse = await agent
      .post("/api/app/auth/accept-invitation")
      .set("x-csrf-token", csrf)
      .send({ token: rawToken, password: "AnotherPassword123" });
    expect(reuse.status).toBe(400);
  });

  it("rejects an unknown token", async () => {
    const app = createApp();
    const agent = request.agent(app);
    const csrf = await getCsrf(agent);
    const res = await agent
      .post("/api/app/auth/accept-invitation")
      .set("x-csrf-token", csrf)
      .send({ token: "not-a-real-token", password: PASSWORD });
    expect(res.status).toBe(400);
  });
});

describe("Password reset", () => {
  it("never reveals whether an email exists", async () => {
    const app = createApp();
    const agent = request.agent(app);
    const csrf = await getCsrf(agent);
    const res = await agent
      .post("/api/app/auth/forgot-password")
      .set("x-csrf-token", csrf)
      .send({ email: "does-not-exist@example.com" });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("rawResetLink");
  });

  it("resets the password with a valid token, and revokes existing sessions", async () => {
    const email = "resetme@example.com";
    await seedActiveUser(email, PASSWORD);

    const app = createApp();
    const agent = request.agent(app);
    const csrf = await getCsrf(agent);

    // Establish a session before the reset, to prove it gets revoked.
    await agent.post("/api/app/auth/login").set("x-csrf-token", csrf).send({ email, password: PASSWORD });
    const meBefore = await agent.get("/api/app/auth/me");
    expect(meBefore.body.user).not.toBeNull();

    const { requestPasswordReset } = await import("../services/auth.service.js");
    const { rawResetLink } = await requestPasswordReset(email);
    expect(rawResetLink).toBeTruthy();
    const token = new URLSearchParams(rawResetLink!.split("?")[1]).get("token")!;

    const newPassword = "BrandNewPassword456";
    const resetRes = await agent.post("/api/app/auth/reset-password").set("x-csrf-token", csrf).send({ token, password: newPassword });
    expect(resetRes.status).toBe(200);

    // Old session cookie should no longer be valid.
    const meAfter = await agent.get("/api/app/auth/me");
    expect(meAfter.body.user).toBeNull();

    // New password works.
    const loginRes = await agent.post("/api/app/auth/login").set("x-csrf-token", csrf).send({ email, password: newPassword });
    expect(loginRes.status).toBe(200);
  });
});
