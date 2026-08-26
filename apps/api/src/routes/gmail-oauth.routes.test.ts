import { describe, expect, it, beforeAll, vi } from "vitest";
import request from "supertest";
import { db } from "@luma/db";

beforeAll(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  process.env.GOOGLE_REDIRECT_URI = "https://example.com/auth/google/callback";
});

const getTokenMock = vi.fn();
vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class MockOAuth2 {
        generateAuthUrl() {
          return "https://accounts.google.com/o/oauth2/mock-consent-screen";
        }
        getToken(code: string) {
          return getTokenMock(code);
        }
      },
    },
  },
}));

const { createApp } = await import("../app.js");

const PASSWORD = "CorrectHorseBattery1";

async function seedUser(email: string, role: "admin" | "manager" | "customer_service") {
  const { appUsersTable } = await import("@luma/db");
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
  return agent;
}

/** Pulls the state param + cookie a real browser would carry from /auth/google into /auth/google/callback. */
function extractState(setCookieHeader: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  const raw = cookies.find((c) => c.startsWith("google_oauth_state="));
  if (!raw) throw new Error("google_oauth_state cookie was not set");
  return raw.split(";")[0].split("=")[1];
}

describe("GET /auth/google", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/auth/google");
    expect(res.status).toBe(401);
  });

  it("rejects a non-admin", async () => {
    await seedUser("gmail-oauth-mgr@example.com", "manager");
    const agent = await loginAgent(app, "gmail-oauth-mgr@example.com");
    const res = await agent.get("/auth/google");
    expect(res.status).toBe(403);
  });

  it("redirects an admin to Google's consent screen and sets the state cookie", async () => {
    await seedUser("gmail-oauth-admin1@example.com", "admin");
    const agent = await loginAgent(app, "gmail-oauth-admin1@example.com");
    const res = await agent.get("/auth/google").redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://accounts.google.com/o/oauth2/mock-consent-screen");
    expect(extractState(res.headers["set-cookie"])).toBeTruthy();
  });
});

describe("GET /auth/google/callback", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("shows the refresh token in the response body so it can be copied into Railway", async () => {
    await seedUser("gmail-oauth-admin2@example.com", "admin");
    const agent = await loginAgent(app, "gmail-oauth-admin2@example.com");

    const start = await agent.get("/auth/google").redirects(0);
    const state = extractState(start.headers["set-cookie"]);

    getTokenMock.mockResolvedValueOnce({ tokens: { refresh_token: "1//mock-refresh-token-abc123" } });
    const callback = await agent.get("/auth/google/callback").query({ code: "mock-auth-code", state });

    expect(callback.status).toBe(200);
    expect(callback.text).toContain("1//mock-refresh-token-abc123");
    expect(callback.text).toContain("GOOGLE_REFRESH_TOKEN");
  });

  it("400s with no persisted token when Google doesn't return a refresh token", async () => {
    await seedUser("gmail-oauth-admin3@example.com", "admin");
    const agent = await loginAgent(app, "gmail-oauth-admin3@example.com");

    const start = await agent.get("/auth/google").redirects(0);
    const state = extractState(start.headers["set-cookie"]);

    getTokenMock.mockResolvedValueOnce({ tokens: {} });
    const callback = await agent.get("/auth/google/callback").query({ code: "mock-auth-code", state });

    expect(callback.status).toBe(400);
  });

  it("400s on a state mismatch (CSRF protection) without calling Google", async () => {
    await seedUser("gmail-oauth-admin4@example.com", "admin");
    const agent = await loginAgent(app, "gmail-oauth-admin4@example.com");

    await agent.get("/auth/google").redirects(0);
    getTokenMock.mockClear();
    const callback = await agent.get("/auth/google/callback").query({ code: "mock-auth-code", state: "wrong-state" });

    expect(callback.status).toBe(400);
    expect(getTokenMock).not.toHaveBeenCalled();
  });
});
