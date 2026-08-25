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

describe("AI assistant", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).post("/api/app/ai-assistant/ask").send({ question: "How many leads?" });
    expect(res.status).toBe(401);
  });

  it("rejects customer_service role", async () => {
    await seedUser("ai-cs@example.com", "customer_service");
    const { agent, csrf } = await loginAgent(app, "ai-cs@example.com");
    const res = await agent.post("/api/app/ai-assistant/ask").set("x-csrf-token", csrf).send({ question: "How many leads?" });
    expect(res.status).toBe(403);
  });

  it("rejects manager role — this is admin-only", async () => {
    await seedUser("ai-mgr@example.com", "manager");
    const { agent, csrf } = await loginAgent(app, "ai-mgr@example.com");
    const res = await agent.post("/api/app/ai-assistant/ask").set("x-csrf-token", csrf).send({ question: "How many leads?" });
    expect(res.status).toBe(403);
  });

  it("rejects an empty question", async () => {
    await seedUser("ai-admin1@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "ai-admin1@example.com");
    const res = await agent.post("/api/app/ai-assistant/ask").set("x-csrf-token", csrf).send({ question: "" });
    expect(res.status).toBe(400);
  });

  // No ANTHROPIC_API_KEY is set in the test environment (see vitest.config.ts),
  // so a well-formed request from an authorized role should fail closed with a
  // clean 503 rather than an unhandled error — this is the code path that runs
  // whenever the key genuinely isn't configured in a real deployment too.
  it("returns 503 when the assistant isn't configured (no ANTHROPIC_API_KEY)", async () => {
    await seedUser("ai-admin2@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "ai-admin2@example.com");
    const res = await agent.post("/api/app/ai-assistant/ask").set("x-csrf-token", csrf).send({ question: "How many leads this month?" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured|isn't configured/i);
  });
});
