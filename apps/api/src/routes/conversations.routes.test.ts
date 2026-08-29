import { describe, expect, it, beforeAll, vi } from "vitest";
import request from "supertest";
import { db, customersTable } from "@luma/db";
import { getOrCreateConversation, appendMessage } from "../services/conversations.service.js";

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
});

const sendEmailMock = vi.fn();
vi.mock("../lib/email-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/email-provider.js")>("../lib/email-provider.js");
  return { ...actual, getEmailProvider: () => ({ provider: { sendEmail: sendEmailMock }, fromName: "Alexis at Ark Health" }) };
});

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
  return { agent, csrf };
}

async function seedCustomer(opts: { phone?: string | null } = {}): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "Route",
      lastName: "Convo",
      email: `route-convo-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-15",
      phone: opts.phone === undefined ? "+15556660001" : opts.phone,
    })
    .returning({ id: customersTable.id });
  return row.id;
}

describe("Conversations", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-secret";
    process.env.INTAKE_LINK_BASE_URL = "http://localhost:3000";
    app = createApp();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/conversations");
    expect(res.status).toBe(401);
  });

  it("rejects manager role — Alexis/Sophie chats are customer_service's scope, not manager's", async () => {
    await seedUser("convo-mgr1@example.com", "manager");
    const { agent } = await loginAgent(app, "convo-mgr1@example.com");
    const res = await agent.get("/api/app/conversations");
    expect(res.status).toBe(403);
  });

  it("lists conversation summaries with the customer's name and last message", async () => {
    await seedUser("convo-cs1@example.com", "customer_service");
    const { agent } = await loginAgent(app, "convo-cs1@example.com");

    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    await appendMessage(conversation.id, "outbound", "Hi there, this is Alexis.");
    await appendMessage(conversation.id, "inbound", "yes I'm interested", { sentiment: "positive" });

    const res = await agent.get("/api/app/conversations");
    expect(res.status).toBe(200);
    const found = res.body.conversations.find((c: { id: string }) => c.id === conversation.id);
    expect(found).toBeDefined();
    expect(found.firstName).toBe("Route");
    expect(found.lastMessagePreview).toBe("yes I'm interested");
    expect(found.lastSentiment).toBe("positive");

    expect(res.body.stats).toBeDefined();
    expect(typeof res.body.stats.totalContacted).toBe("number");
    expect(typeof res.body.stats.totalResponded).toBe("number");
    expect(typeof res.body.stats.responseRate).toBe("number");
    // This conversation (outbound then inbound) is included in the global count.
    expect(res.body.stats.totalResponded).toBeGreaterThanOrEqual(1);

    // channel=email is a separate list entirely — an email conversation for
    // this same customer must not leak into the SMS list, and must show up
    // (with its own preview/sentiment) under ?channel=email. Reuses this
    // test's login rather than a fresh one — the auth rate limiter caps
    // logins per test file, so every test in this file shares its agent
    // across both the SMS assertion above and this email assertion.
    const { getOrCreateEmailConversation, appendEmailMessage } = await import("../services/email-conversations.service.js");
    const emailConversation = await getOrCreateEmailConversation(personId);
    await appendEmailMessage(emailConversation.id, "outbound", "Welcome", "Hi there, this is Alexis.");
    await appendEmailMessage(emailConversation.id, "inbound", "Re: Welcome", "yes I'm interested by email", { sentiment: "positive" });

    const smsListRes = await agent.get("/api/app/conversations");
    expect(smsListRes.body.conversations.some((c: { id: string }) => c.id === emailConversation.id)).toBe(false);

    const emailListRes = await agent.get("/api/app/conversations").query({ channel: "email" });
    expect(emailListRes.status).toBe(200);
    const foundEmail = emailListRes.body.conversations.find((c: { id: string }) => c.id === emailConversation.id);
    expect(foundEmail).toBeDefined();
    expect(foundEmail.lastMessagePreview).toBe("yes I'm interested by email");
    expect(foundEmail.lastSentiment).toBe("positive");
    expect(emailListRes.body.stats).toBeDefined();

    // A bare "ORDER BY ... DESC" sorts NULLs first in Postgres, which would
    // put a zero-message email conversation ahead of the active one above —
    // the opposite of "most recently active first". Reuses this test's
    // login/customer setup rather than a fresh one (see rate-limiter note).
    const emptyPersonId = await seedCustomer();
    const emptyEmailConversation = await getOrCreateEmailConversation(emptyPersonId);
    const afterEmailListRes = await agent.get("/api/app/conversations").query({ channel: "email" });
    const activeIndex = afterEmailListRes.body.conversations.findIndex((c: { id: string }) => c.id === emailConversation.id);
    const emptyIndex = afterEmailListRes.body.conversations.findIndex((c: { id: string }) => c.id === emptyEmailConversation.id);
    expect(activeIndex).toBeGreaterThanOrEqual(0);
    expect(emptyIndex).toBeGreaterThanOrEqual(0);
    expect(activeIndex).toBeLessThan(emptyIndex);
  });

  it("returns conversation detail with customer contact and full message history", async () => {
    await seedUser("convo-admin1@example.com", "admin");
    const { agent } = await loginAgent(app, "convo-admin1@example.com");

    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    await appendMessage(conversation.id, "outbound", "message one");
    await appendMessage(conversation.id, "inbound", "message two");

    const res = await agent.get(`/api/app/conversations/${conversation.id}`);
    expect(res.status).toBe(200);
    expect(res.body.customer.firstName).toBe("Route");
    expect(res.body.messages).toHaveLength(2);

    // channel=email detail, reusing this test's login (see rate-limiter note above).
    const { getOrCreateEmailConversation, appendEmailMessage } = await import("../services/email-conversations.service.js");
    const emailConversation = await getOrCreateEmailConversation(personId);
    await appendEmailMessage(emailConversation.id, "outbound", "Welcome to Ark Health", "email message one");

    const emailRes = await agent.get(`/api/app/conversations/${emailConversation.id}`).query({ channel: "email" });
    expect(emailRes.status).toBe(200);
    expect(emailRes.body.customer.firstName).toBe("Route");
    expect(emailRes.body.customer.email).toBeTruthy();
    expect(emailRes.body.messages).toHaveLength(1);
    expect(emailRes.body.messages[0].subject).toBe("Welcome to Ark Health");
  });

  it("returns 404 for an unknown conversation id", async () => {
    await seedUser("convo-admin2@example.com", "admin");
    const { agent } = await loginAgent(app, "convo-admin2@example.com");
    const res = await agent.get("/api/app/conversations/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("summaries and detail include needsAttention, and clear-attention resets it", async () => {
    await seedUser("convo-admin3@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "convo-admin3@example.com");

    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    const { updateConversationState } = await import("../services/conversations.service.js");
    await updateConversationState(conversation.id, { needsAttention: true });

    const listRes = await agent.get("/api/app/conversations");
    const found = listRes.body.conversations.find((c: { id: string }) => c.id === conversation.id);
    expect(found.needsAttention).toBe(true);

    const detailRes = await agent.get(`/api/app/conversations/${conversation.id}`);
    expect(detailRes.body.conversation.needsAttention).toBe(true);

    const clearRes = await agent.post(`/api/app/conversations/${conversation.id}/clear-attention`).set("x-csrf-token", csrf).send({});
    expect(clearRes.status).toBe(200);

    const afterRes = await agent.get(`/api/app/conversations/${conversation.id}`);
    expect(afterRes.body.conversation.needsAttention).toBe(false);

    // Same check for channel=email, reusing this test's login (see rate-limiter note above) —
    // needsAttention is a genuinely separate flag on the email_conversations table.
    const { getOrCreateEmailConversation, updateEmailConversationState } = await import("../services/email-conversations.service.js");
    const emailConversation = await getOrCreateEmailConversation(personId);
    await updateEmailConversationState(emailConversation.id, { needsAttention: true });

    const emailClearRes = await agent
      .post(`/api/app/conversations/${emailConversation.id}/clear-attention`)
      .query({ channel: "email" })
      .set("x-csrf-token", csrf)
      .send({});
    expect(emailClearRes.status).toBe(200);

    const emailAfterRes = await agent.get(`/api/app/conversations/${emailConversation.id}`).query({ channel: "email" });
    expect(emailAfterRes.body.conversation.needsAttention).toBe(false);
  });

  it("clear-attention returns 404 for an unknown conversation id", async () => {
    await seedUser("convo-admin4@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "convo-admin4@example.com");
    const res = await agent.post("/api/app/conversations/00000000-0000-0000-0000-000000000000/clear-attention").set("x-csrf-token", csrf).send({});
    expect(res.status).toBe(404);
  });

  describe("staff reply", () => {
    it("sends the reply, logs it, and clears needsAttention", async () => {
      sendMessageMock.mockClear();
      sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_route_reply_1" });

      await seedUser("convo-reply1@example.com", "admin");
      const { agent, csrf } = await loginAgent(app, "convo-reply1@example.com");

      const personId = await seedCustomer({ phone: "+15556660010" });
      const conversation = await getOrCreateConversation(personId);
      const { updateConversationState } = await import("../services/conversations.service.js");
      await updateConversationState(conversation.id, { needsAttention: true });

      const res = await agent
        .post(`/api/app/conversations/${conversation.id}/reply`)
        .set("x-csrf-token", csrf)
        .send({ body: "Following up on that for you." });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sent: true });
      expect(sendMessageMock).toHaveBeenCalledWith("+15556660010", "Following up on that for you.");

      const detailRes = await agent.get(`/api/app/conversations/${conversation.id}`);
      expect(detailRes.body.conversation.needsAttention).toBe(false);
      expect(detailRes.body.messages.at(-1)).toMatchObject({ direction: "outbound", body: "Following up on that for you." });

      // channel=email staff reply, reusing this test's login (see rate-limiter note above) —
      // sent through the real email provider, greeted/signed-off, and threaded off the last message.
      sendEmailMock.mockClear();
      sendEmailMock.mockResolvedValueOnce({ messageId: "<staff-reply-1@example.com>" });

      const { getOrCreateEmailConversation, appendEmailMessage, updateEmailConversationState } = await import("../services/email-conversations.service.js");
      const emailConversation = await getOrCreateEmailConversation(personId);
      const inboundEmail = await appendEmailMessage(emailConversation.id, "inbound", "Question", "Has my order shipped?", { messageId: "<inbound-q@example.com>" });
      await updateEmailConversationState(emailConversation.id, { needsAttention: true });

      const emailReplyRes = await agent
        .post(`/api/app/conversations/${emailConversation.id}/reply`)
        .query({ channel: "email" })
        .set("x-csrf-token", csrf)
        .send({ body: "It shipped this morning." });

      expect(emailReplyRes.status).toBe(200);
      expect(emailReplyRes.body).toEqual({ sent: true });
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      const [, subject, html, opts] = sendEmailMock.mock.calls[0];
      expect(subject).toBe("Re: Question");
      expect(html).toContain("It shipped this morning.");
      expect(html).toContain("— Alexis at Ark Health");
      expect(opts.inReplyTo).toBe(inboundEmail.messageId);

      const emailDetailRes = await agent.get(`/api/app/conversations/${emailConversation.id}`).query({ channel: "email" });
      expect(emailDetailRes.body.conversation.needsAttention).toBe(false);
      expect(emailDetailRes.body.messages.at(-1)).toMatchObject({ direction: "outbound", subject: "Re: Question" });
    });

    it("rejects an empty body with 400", async () => {
      await seedUser("convo-reply2@example.com", "admin");
      const { agent, csrf } = await loginAgent(app, "convo-reply2@example.com");
      const personId = await seedCustomer();
      const conversation = await getOrCreateConversation(personId);

      const res = await agent.post(`/api/app/conversations/${conversation.id}/reply`).set("x-csrf-token", csrf).send({ body: "" });
      expect(res.status).toBe(400);
    });

    it("returns 404 for an unknown conversation id", async () => {
      await seedUser("convo-reply3@example.com", "admin");
      const { agent, csrf } = await loginAgent(app, "convo-reply3@example.com");
      const res = await agent
        .post("/api/app/conversations/00000000-0000-0000-0000-000000000000/reply")
        .set("x-csrf-token", csrf)
        .send({ body: "hi" });
      expect(res.status).toBe(404);
    });

    it("requires authentication", async () => {
      const personId = await seedCustomer();
      const conversation = await getOrCreateConversation(personId);
      const res = await request(app).post(`/api/app/conversations/${conversation.id}/reply`).send({ body: "hi" });
      expect(res.status).toBe(401);
    });

    it("rejects manager role", async () => {
      await seedUser("convo-reply4@example.com", "manager");
      const { agent, csrf } = await loginAgent(app, "convo-reply4@example.com");
      const personId = await seedCustomer();
      const conversation = await getOrCreateConversation(personId);
      const res = await agent.post(`/api/app/conversations/${conversation.id}/reply`).set("x-csrf-token", csrf).send({ body: "hi" });
      expect(res.status).toBe(403);
    });
  });

});
