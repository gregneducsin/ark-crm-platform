import { describe, expect, it, beforeAll, vi } from "vitest";
import request from "supertest";
import { db, customersTable } from "@luma/db";
import { getOrCreateSupportConversation, appendSupportMessage } from "../services/support-conversations.service.js";

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
});

const sendEmailMock = vi.fn();
vi.mock("../lib/email-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/email-provider.js")>("../lib/email-provider.js");
  return { ...actual, getEmailProvider: () => ({ provider: { sendEmail: sendEmailMock }, fromName: "Sophie at Ark Health" }) };
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
      lastName: "Support",
      email: `route-support-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-16",
      phone: opts.phone === undefined ? "+15556660001" : opts.phone,
    })
    .returning({ id: customersTable.id });
  return row.id;
}

describe("Support conversations", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-secret";
    process.env.INTAKE_LINK_BASE_URL = "http://localhost:3000";
    app = createApp();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/app/support-conversations");
    expect(res.status).toBe(401);
  });

  it("rejects manager role — Alexis/Sophie chats are customer_service's scope, not manager's", async () => {
    await seedUser("support-mgr1@example.com", "manager");
    const { agent } = await loginAgent(app, "support-mgr1@example.com");
    const res = await agent.get("/api/app/support-conversations");
    expect(res.status).toBe(403);
  });

  it("lists conversation summaries with the customer's name and last message", async () => {
    await seedUser("support-cs1@example.com", "customer_service");
    const { agent } = await loginAgent(app, "support-cs1@example.com");

    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    await appendSupportMessage(conversation.id, "outbound", "Hi, this is Sophie.");
    await appendSupportMessage(conversation.id, "inbound", "Thanks for the update!", { sentiment: "positive" });

    const res = await agent.get("/api/app/support-conversations");
    expect(res.status).toBe(200);
    const found = res.body.conversations.find((c: { id: string }) => c.id === conversation.id);
    expect(found).toBeDefined();
    expect(found.firstName).toBe("Route");
    expect(found.lastMessagePreview).toBe("Thanks for the update!");
    expect(found.lastSentiment).toBe("positive");

    // channel=email is a separate list entirely — reuses this test's login
    // rather than a fresh one, since the auth rate limiter caps logins per
    // test file and every test in this file already sits at that budget.
    const { getOrCreateSupportEmailConversation, appendSupportEmailMessage } = await import("../services/support-email-conversations.service.js");
    const emailConversation = await getOrCreateSupportEmailConversation(personId);
    await appendSupportEmailMessage(emailConversation.id, "outbound", "Order update", "Hi, this is Sophie.");
    await appendSupportEmailMessage(emailConversation.id, "inbound", "Re: Order update", "Thanks for the email update!", { sentiment: "positive" });

    const smsListRes = await agent.get("/api/app/support-conversations");
    expect(smsListRes.body.conversations.some((c: { id: string }) => c.id === emailConversation.id)).toBe(false);

    const emailListRes = await agent.get("/api/app/support-conversations").query({ channel: "email" });
    expect(emailListRes.status).toBe(200);
    const foundEmail = emailListRes.body.conversations.find((c: { id: string }) => c.id === emailConversation.id);
    expect(foundEmail).toBeDefined();
    expect(foundEmail.lastMessagePreview).toBe("Thanks for the email update!");
    expect(foundEmail.lastSentiment).toBe("positive");
  });

  it("returns conversation detail with customer contact and full message history", async () => {
    await seedUser("support-admin1@example.com", "admin");
    const { agent } = await loginAgent(app, "support-admin1@example.com");

    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    await appendSupportMessage(conversation.id, "outbound", "message one");
    await appendSupportMessage(conversation.id, "inbound", "message two");

    const res = await agent.get(`/api/app/support-conversations/${conversation.id}`);
    expect(res.status).toBe(200);
    expect(res.body.customer.firstName).toBe("Route");
    expect(res.body.messages).toHaveLength(2);

    // channel=email detail, reusing this test's login (see rate-limiter note above).
    const { getOrCreateSupportEmailConversation, appendSupportEmailMessage } = await import("../services/support-email-conversations.service.js");
    const emailConversation = await getOrCreateSupportEmailConversation(personId);
    await appendSupportEmailMessage(emailConversation.id, "outbound", "Where's my order?", "email message one");

    const emailRes = await agent.get(`/api/app/support-conversations/${emailConversation.id}`).query({ channel: "email" });
    expect(emailRes.status).toBe(200);
    expect(emailRes.body.customer.firstName).toBe("Route");
    expect(emailRes.body.customer.email).toBeTruthy();
    expect(emailRes.body.messages).toHaveLength(1);
    expect(emailRes.body.messages[0].subject).toBe("Where's my order?");
  });

  it("returns 404 for an unknown conversation id", async () => {
    await seedUser("support-admin2@example.com", "admin");
    const { agent } = await loginAgent(app, "support-admin2@example.com");
    const res = await agent.get("/api/app/support-conversations/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("clear-attention resets needsAttention", async () => {
    await seedUser("support-admin3@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "support-admin3@example.com");

    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    const { updateSupportConversationState } = await import("../services/support-conversations.service.js");
    await updateSupportConversationState(conversation.id, { needsAttention: true });

    const listRes = await agent.get("/api/app/support-conversations");
    const found = listRes.body.conversations.find((c: { id: string }) => c.id === conversation.id);
    expect(found.needsAttention).toBe(true);

    const clearRes = await agent.post(`/api/app/support-conversations/${conversation.id}/clear-attention`).set("x-csrf-token", csrf).send({});
    expect(clearRes.status).toBe(200);

    const afterRes = await agent.get(`/api/app/support-conversations/${conversation.id}`);
    expect(afterRes.body.conversation.needsAttention).toBe(false);

    // Same check for channel=email, reusing this test's login (see rate-limiter note above).
    const { getOrCreateSupportEmailConversation, updateSupportEmailConversationState } = await import(
      "../services/support-email-conversations.service.js"
    );
    const emailConversation = await getOrCreateSupportEmailConversation(personId);
    await updateSupportEmailConversationState(emailConversation.id, { needsAttention: true });

    const emailClearRes = await agent
      .post(`/api/app/support-conversations/${emailConversation.id}/clear-attention`)
      .query({ channel: "email" })
      .set("x-csrf-token", csrf)
      .send({});
    expect(emailClearRes.status).toBe(200);

    const emailAfterRes = await agent.get(`/api/app/support-conversations/${emailConversation.id}`).query({ channel: "email" });
    expect(emailAfterRes.body.conversation.needsAttention).toBe(false);
  });

  it("clear-attention returns 404 for an unknown conversation id", async () => {
    await seedUser("support-admin4@example.com", "admin");
    const { agent, csrf } = await loginAgent(app, "support-admin4@example.com");
    const res = await agent.post("/api/app/support-conversations/00000000-0000-0000-0000-000000000000/clear-attention").set("x-csrf-token", csrf).send({});
    expect(res.status).toBe(404);
  });

  describe("staff reply", () => {
    it("sends the reply, logs it, and clears needsAttention", async () => {
      sendMessageMock.mockClear();
      sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_route_support_reply_1" });

      await seedUser("support-reply1@example.com", "admin");
      const { agent, csrf } = await loginAgent(app, "support-reply1@example.com");

      const personId = await seedCustomer({ phone: "+15556660020" });
      const conversation = await getOrCreateSupportConversation(personId);
      const { updateSupportConversationState } = await import("../services/support-conversations.service.js");
      await updateSupportConversationState(conversation.id, { needsAttention: true });

      const res = await agent
        .post(`/api/app/support-conversations/${conversation.id}/reply`)
        .set("x-csrf-token", csrf)
        .send({ body: "Your label has the exact timing instructions." });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sent: true });
      expect(sendMessageMock).toHaveBeenCalledWith("+15556660020", "Your label has the exact timing instructions.");

      const detailRes = await agent.get(`/api/app/support-conversations/${conversation.id}`);
      expect(detailRes.body.conversation.needsAttention).toBe(false);
      expect(detailRes.body.messages.at(-1)).toMatchObject({ direction: "outbound", body: "Your label has the exact timing instructions." });

      // channel=email staff reply, reusing this test's login (see rate-limiter note above) —
      // sent through the real email provider, greeted/signed-off, and threaded off the last message.
      sendEmailMock.mockClear();
      sendEmailMock.mockResolvedValueOnce({ messageId: "<staff-support-reply-1@example.com>" });

      const { getOrCreateSupportEmailConversation, appendSupportEmailMessage, updateSupportEmailConversationState } = await import(
        "../services/support-email-conversations.service.js"
      );
      const emailConversation = await getOrCreateSupportEmailConversation(personId);
      const inboundEmail = await appendSupportEmailMessage(emailConversation.id, "inbound", "Order question", "When does it ship?", {
        messageId: "<inbound-support-q@example.com>",
      });
      await updateSupportEmailConversationState(emailConversation.id, { needsAttention: true });

      const emailReplyRes = await agent
        .post(`/api/app/support-conversations/${emailConversation.id}/reply`)
        .query({ channel: "email" })
        .set("x-csrf-token", csrf)
        .send({ body: "It ships tomorrow morning." });

      expect(emailReplyRes.status).toBe(200);
      expect(emailReplyRes.body).toEqual({ sent: true });
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      const [, subject, html, opts] = sendEmailMock.mock.calls[0];
      expect(subject).toBe("Re: Order question");
      expect(html).toContain("It ships tomorrow morning.");
      expect(html).toContain("— Sophie at Ark Health");
      expect(opts.inReplyTo).toBe(inboundEmail.messageId);

      const emailDetailRes = await agent.get(`/api/app/support-conversations/${emailConversation.id}`).query({ channel: "email" });
      expect(emailDetailRes.body.conversation.needsAttention).toBe(false);
      expect(emailDetailRes.body.messages.at(-1)).toMatchObject({ direction: "outbound", subject: "Re: Order question" });
    });

    it("rejects an empty body with 400", async () => {
      await seedUser("support-reply2@example.com", "admin");
      const { agent, csrf } = await loginAgent(app, "support-reply2@example.com");
      const personId = await seedCustomer();
      const conversation = await getOrCreateSupportConversation(personId);

      const res = await agent.post(`/api/app/support-conversations/${conversation.id}/reply`).set("x-csrf-token", csrf).send({ body: "" });
      expect(res.status).toBe(400);
    });

    it("returns 404 for an unknown conversation id", async () => {
      await seedUser("support-reply3@example.com", "admin");
      const { agent, csrf } = await loginAgent(app, "support-reply3@example.com");
      const res = await agent
        .post("/api/app/support-conversations/00000000-0000-0000-0000-000000000000/reply")
        .set("x-csrf-token", csrf)
        .send({ body: "hi" });
      expect(res.status).toBe(404);
    });

    it("requires authentication", async () => {
      const personId = await seedCustomer();
      const conversation = await getOrCreateSupportConversation(personId);
      const res = await request(app).post(`/api/app/support-conversations/${conversation.id}/reply`).send({ body: "hi" });
      expect(res.status).toBe(401);
    });

    it("rejects manager role", async () => {
      await seedUser("support-reply4@example.com", "manager");
      const { agent, csrf } = await loginAgent(app, "support-reply4@example.com");
      const personId = await seedCustomer();
      const conversation = await getOrCreateSupportConversation(personId);
      const res = await agent.post(`/api/app/support-conversations/${conversation.id}/reply`).set("x-csrf-token", csrf).send({ body: "hi" });
      expect(res.status).toBe(403);
    });
  });

});
