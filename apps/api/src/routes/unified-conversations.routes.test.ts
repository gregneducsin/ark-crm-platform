import { describe, expect, it, beforeAll, vi } from "vitest";
import request from "supertest";

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
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

async function seedSalesThread(): Promise<string> {
  const { db, customersTable } = await import("@luma/db");
  const { getOrCreateConversation, appendMessage } = await import("../services/conversations.service.js");
  const [customer] = await db
    .insert(customersTable)
    .values({ firstName: "Route", lastName: "Test", email: `unified-route-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15", phone: "+15558880003" })
    .returning({ id: customersTable.id });
  const conv = await getOrCreateConversation(customer.id);
  await appendMessage(conv.id, "outbound", "hi");
  return customer.id;
}

describe("GET /api/app/conversations (unified)", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/conversations");
    expect(res.status).toBe(401);
  });

  it("allows admin and customer_service", async () => {
    await seedUser("unifiedconvo-admin1@example.com", "admin");
    const admin = await loginAgent(app, "unifiedconvo-admin1@example.com");
    expect((await admin.agent.get("/api/app/conversations")).status).toBe(200);

    await seedUser("unifiedconvo-cs1@example.com", "customer_service");
    const cs = await loginAgent(app, "unifiedconvo-cs1@example.com");
    expect((await cs.agent.get("/api/app/conversations")).status).toBe(200);
  });

  it("rejects manager", async () => {
    await seedUser("unifiedconvo-mgr1@example.com", "manager");
    const manager = await loginAgent(app, "unifiedconvo-mgr1@example.com");
    expect((await manager.agent.get("/api/app/conversations")).status).toBe(403);
  });

  it("returns conversations and salesStats", async () => {
    await seedUser("unifiedconvo-admin2@example.com", "admin");
    const { agent } = await loginAgent(app, "unifiedconvo-admin2@example.com");
    const personId = await seedSalesThread();

    const res = await agent.get("/api/app/conversations");
    expect(res.status).toBe(200);
    expect(res.body.conversations.some((c: { personId: string }) => c.personId === personId)).toBe(true);
    expect(res.body.salesStats).toMatchObject({ totalContacted: expect.any(Number), totalResponded: expect.any(Number), responseRate: expect.any(Number) });
  });
});

describe("GET /api/app/conversations/:personId", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("returns the merged detail for a person with a thread", async () => {
    await seedUser("unifiedconvo-admin3@example.com", "admin");
    const { agent } = await loginAgent(app, "unifiedconvo-admin3@example.com");
    const personId = await seedSalesThread();

    const res = await agent.get(`/api/app/conversations/${personId}`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.availableReplyTargets).toEqual([{ persona: "sales", channel: "sms" }]);
  });

  it("404s for a person with no conversation at all", async () => {
    await seedUser("unifiedconvo-admin4@example.com", "admin");
    const { agent } = await loginAgent(app, "unifiedconvo-admin4@example.com");

    const res = await agent.get("/api/app/conversations/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/app/conversations/:personId/clear-attention", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("clears a flagged thread", async () => {
    await seedUser("unifiedconvo-admin5@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "unifiedconvo-admin5@example.com");
    const personId = await seedSalesThread();
    const { getOrCreateConversation, updateConversationState } = await import("../services/conversations.service.js");
    const conv = await getOrCreateConversation(personId);
    await updateConversationState(conv.id, { needsAttention: true, needsAttentionReason: "test" });

    const res = await agent.post(`/api/app/conversations/${personId}/clear-attention`).set("x-csrf-token", csrf).send();
    expect(res.status).toBe(200);

    const detail = await agent.get(`/api/app/conversations/${personId}`);
    expect(detail.body.sales.needsAttention).toBe(false);
  });
});

describe("POST /api/app/conversations/:personId/reply", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("sends a reply through the requested pipeline", async () => {
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_route_1" });
    await seedUser("unifiedconvo-admin6@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "unifiedconvo-admin6@example.com");
    const personId = await seedSalesThread();

    const res = await agent.post(`/api/app/conversations/${personId}/reply`).set("x-csrf-token", csrf).send({ persona: "sales", channel: "sms", body: "hello" });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(true);
  });

  it("rejects an invalid payload with 400", async () => {
    await seedUser("unifiedconvo-admin7@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "unifiedconvo-admin7@example.com");
    const personId = await seedSalesThread();

    const res = await agent.post(`/api/app/conversations/${personId}/reply`).set("x-csrf-token", csrf).send({ persona: "not-a-persona", channel: "sms", body: "hello" });
    expect(res.status).toBe(400);
  });

  it("404s when the requested pipeline has no thread for this person", async () => {
    await seedUser("unifiedconvo-admin8@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "unifiedconvo-admin8@example.com");
    const personId = await seedSalesThread();

    const res = await agent.post(`/api/app/conversations/${personId}/reply`).set("x-csrf-token", csrf).send({ persona: "support", channel: "email", body: "hello" });
    expect(res.status).toBe(404);
  });
});
