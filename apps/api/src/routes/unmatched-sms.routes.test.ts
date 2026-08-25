import { describe, expect, it, beforeAll, vi } from "vitest";
import request from "supertest";
import { db } from "@luma/db";

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.SMS_PROVIDER = "iblusend";
  process.env.IBLUSEND_API_KEY = "iblu_test_abc123";
});

const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: createMock };
  },
}));

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
});

const { createApp } = await import("../app.js");
const { recordAndClassifyUnmatchedSms } = await import("../services/unmatched-inbound-sms.service.js");

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
  return { agent, csrf };
}

function toolResponse(input: Record<string, unknown>) {
  return { content: [{ type: "tool_use", name: "classify_unmatched_sms", input }] };
}

let phoneCounter = 0;
function uniquePhone(): string {
  phoneCounter += 1;
  return `+1555${String(3000000 + phoneCounter).padStart(7, "0")}`;
}

describe("Unmatched SMS", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/unmatched-sms");
    expect(res.status).toBe(401);
  });

  it("rejects manager role — unmatched contacts is customer_service's scope, not manager's", async () => {
    await seedUser("unmatched-sms-mgr1@example.com", "manager");
    const { agent } = await loginAgent(app, "unmatched-sms-mgr1@example.com");
    const res = await agent.get("/api/app/unmatched-sms");
    expect(res.status).toBe(403);
  });

  it("allows customer_service role", async () => {
    await seedUser("unmatched-sms-cs1@example.com", "customer_service");
    const { agent } = await loginAgent(app, "unmatched-sms-cs1@example.com");
    const res = await agent.get("/api/app/unmatched-sms");
    expect(res.status).toBe(200);
  });

  it("lists, fetches by id, replies (sends through the real provider), and dismisses", async () => {
    await seedUser("unmatched-sms-admin1@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "unmatched-sms-admin1@example.com");

    createMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack_1" });
    createMock.mockResolvedValueOnce(
      toolResponse({
        intent: "new_lead_interest",
        summary: "Asking about programs.",
        suggestedReply: "A member of our team will follow up shortly.",
        senderName: null,
        senderEmail: null,
        matchCandidateIndex: null,
        matchConfidence: null,
      }),
    );
    const toReply = await recordAndClassifyUnmatchedSms(uniquePhone(), "Tell me more");

    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack_2" });
    createMock.mockResolvedValueOnce(
      toolResponse({ intent: "spam_or_irrelevant", summary: "Marketing spam.", suggestedReply: null, senderName: null, senderEmail: null, matchCandidateIndex: null, matchConfidence: null }),
    );
    const toDismiss = await recordAndClassifyUnmatchedSms(uniquePhone(), "buy now");

    const listRes = await agent.get("/api/app/unmatched-sms");
    expect(listRes.status).toBe(200);
    expect(listRes.body.items.some((i: { id: string }) => i.id === toReply.id)).toBe(true);
    expect(listRes.body.items.some((i: { id: string }) => i.id === toDismiss.id)).toBe(true);

    const detailRes = await agent.get(`/api/app/unmatched-sms/${toReply.id}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.fromPhone).toBe(toReply.fromPhone);
    expect(detailRes.body.aiSummary).toBe("Asking about programs.");

    sendMessageMock.mockClear(); // the setup calls above also trigger the first-message auto-acknowledgment sends
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_staff_reply" });
    const replyRes = await agent
      .post(`/api/app/unmatched-sms/${toReply.id}/reply`)
      .set("x-csrf-token", csrf)
      .send({ body: "A member of our team will follow up with details." });
    expect(replyRes.status).toBe(200);
    expect(replyRes.body).toEqual({ sent: true });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [to, body] = sendMessageMock.mock.calls[0];
    expect(to).toBe(toReply.fromPhone);
    expect(body).toBe("A member of our team will follow up with details.");

    const afterReplyRes = await agent.get(`/api/app/unmatched-sms/${toReply.id}`);
    expect(afterReplyRes.body.status).toBe("replied");

    const dismissRes = await agent.post(`/api/app/unmatched-sms/${toDismiss.id}/dismiss`).set("x-csrf-token", csrf).send({});
    expect(dismissRes.status).toBe(200);
    const afterDismissRes = await agent.get(`/api/app/unmatched-sms/${toDismiss.id}`);
    expect(afterDismissRes.body.status).toBe("dismissed");

    // 404s and validation, reusing this same login.
    const missingReplyRes = await agent
      .post("/api/app/unmatched-sms/00000000-0000-0000-0000-000000000000/reply")
      .set("x-csrf-token", csrf)
      .send({ body: "hi" });
    expect(missingReplyRes.status).toBe(404);

    const missingDismissRes = await agent.post("/api/app/unmatched-sms/00000000-0000-0000-0000-000000000000/dismiss").set("x-csrf-token", csrf).send({});
    expect(missingDismissRes.status).toBe(404);

    const emptyBodyRes = await agent.post(`/api/app/unmatched-sms/${toReply.id}/reply`).set("x-csrf-token", csrf).send({ body: "" });
    expect(emptyBodyRes.status).toBe(400);

    const missingGetRes = await agent.get("/api/app/unmatched-sms/00000000-0000-0000-0000-000000000000");
    expect(missingGetRes.status).toBe(404);
  });
});
