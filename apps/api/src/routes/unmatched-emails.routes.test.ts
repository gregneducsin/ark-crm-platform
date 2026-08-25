import { describe, expect, it, beforeAll, vi } from "vitest";
import request from "supertest";
import { db } from "@luma/db";

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.EMAIL_PROVIDER = "google_workspace";
  process.env.GOOGLE_WORKSPACE_SMTP_USER = "bot@example.com";
  process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD = "app-password";
});

const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: createMock };
  },
}));

const sendEmailMock = vi.fn();
vi.mock("../lib/email-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/email-provider.js")>("../lib/email-provider.js");
  return { ...actual, getEmailProvider: () => ({ provider: { sendEmail: sendEmailMock }, fromName: "Alexis at Ark Health" }) };
});

const { createApp } = await import("../app.js");
const { recordAndClassifyUnmatchedEmail } = await import("../services/unmatched-inbound-email.service.js");

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
  return { content: [{ type: "tool_use", name: "classify_unmatched_email", input }] };
}

describe("Unmatched emails", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/unmatched-emails");
    expect(res.status).toBe(401);
  });

  it("rejects manager role — unmatched contacts is customer_service's scope, not manager's", async () => {
    await seedUser("unmatched-mgr1@example.com", "manager");
    const { agent } = await loginAgent(app, "unmatched-mgr1@example.com");
    const res = await agent.get("/api/app/unmatched-emails");
    expect(res.status).toBe(403);
  });

  it("allows customer_service role", async () => {
    await seedUser("unmatched-cs1@example.com", "customer_service");
    const { agent } = await loginAgent(app, "unmatched-cs1@example.com");
    const res = await agent.get("/api/app/unmatched-emails");
    expect(res.status).toBe(200);
  });

  it("lists, fetches by id, replies (sends through the real provider, threaded), and dismisses", async () => {
    await seedUser("unmatched-admin1@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "unmatched-admin1@example.com");

    createMock.mockClear();
    createMock.mockResolvedValueOnce(
      toolResponse({
        intent: "new_lead_interest",
        summary: "Asking about programs.",
        suggestedReply: "A member of our team will follow up shortly.",
        matchCandidateIndex: null,
        matchConfidence: null,
      }),
    );
    const toReply = await recordAndClassifyUnmatchedEmail({
      fromAddress: "route-reply@example.com",
      fromName: null,
      subject: "Question",
      body: "Tell me more",
      messageId: "<route-original@example.com>",
    });

    createMock.mockResolvedValueOnce(
      toolResponse({ intent: "spam_or_irrelevant", summary: "Marketing spam.", suggestedReply: null, matchCandidateIndex: null, matchConfidence: null }),
    );
    const toDismiss = await recordAndClassifyUnmatchedEmail({ fromAddress: "route-dismiss@example.com", fromName: null, subject: "Spam", body: "buy now", messageId: null });

    const listRes = await agent.get("/api/app/unmatched-emails");
    expect(listRes.status).toBe(200);
    expect(listRes.body.items.some((i: { id: string }) => i.id === toReply.id)).toBe(true);
    expect(listRes.body.items.some((i: { id: string }) => i.id === toDismiss.id)).toBe(true);

    const detailRes = await agent.get(`/api/app/unmatched-emails/${toReply.id}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.fromAddress).toBe("route-reply@example.com");
    expect(detailRes.body.aiSummary).toBe("Asking about programs.");

    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<staff-reply@example.com>" });
    const replyRes = await agent
      .post(`/api/app/unmatched-emails/${toReply.id}/reply`)
      .set("x-csrf-token", csrf)
      .send({ body: "A member of our team will follow up with details." });
    expect(replyRes.status).toBe(200);
    expect(replyRes.body).toEqual({ sent: true });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [, subject, , opts] = sendEmailMock.mock.calls[0];
    expect(subject).toBe("Re: Question");
    expect(opts.inReplyTo).toBe("<route-original@example.com>");

    const afterReplyRes = await agent.get(`/api/app/unmatched-emails/${toReply.id}`);
    expect(afterReplyRes.body.status).toBe("replied");

    const dismissRes = await agent.post(`/api/app/unmatched-emails/${toDismiss.id}/dismiss`).set("x-csrf-token", csrf).send({});
    expect(dismissRes.status).toBe(200);
    const afterDismissRes = await agent.get(`/api/app/unmatched-emails/${toDismiss.id}`);
    expect(afterDismissRes.body.status).toBe("dismissed");

    // 404s and validation, reusing this same login.
    const missingReplyRes = await agent
      .post("/api/app/unmatched-emails/00000000-0000-0000-0000-000000000000/reply")
      .set("x-csrf-token", csrf)
      .send({ body: "hi" });
    expect(missingReplyRes.status).toBe(404);

    const missingDismissRes = await agent.post("/api/app/unmatched-emails/00000000-0000-0000-0000-000000000000/dismiss").set("x-csrf-token", csrf).send({});
    expect(missingDismissRes.status).toBe(404);

    const emptyBodyRes = await agent.post(`/api/app/unmatched-emails/${toReply.id}/reply`).set("x-csrf-token", csrf).send({ body: "" });
    expect(emptyBodyRes.status).toBe(400);

    const missingGetRes = await agent.get("/api/app/unmatched-emails/00000000-0000-0000-0000-000000000000");
    expect(missingGetRes.status).toBe(404);
  });
});
