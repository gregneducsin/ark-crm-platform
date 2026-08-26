import { describe, expect, it, vi, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";
import type { SophieTurnResult } from "./sophie-conversation.service.js";
import { isCustomerEmailDnd, setCustomerEmailDnd } from "./dnd.service.js";

beforeAll(() => {
  process.env.EMAIL_PROVIDER = "google_workspace";
  process.env.GOOGLE_WORKSPACE_SMTP_USER = "bot@example.com";
  process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD = "app-password";
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-secret";
  process.env.INTAKE_LINK_BASE_URL = "http://localhost:3000";
});

const runSophieTurnMock = vi.fn();
vi.mock("./sophie-conversation.service.js", async () => {
  const actual = await vi.importActual<typeof import("./sophie-conversation.service.js")>("./sophie-conversation.service.js");
  return { ...actual, runSophieTurn: (...args: unknown[]) => runSophieTurnMock(...args) };
});

const sendEmailMock = vi.fn();
vi.mock("../lib/email-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/email-provider.js")>("../lib/email-provider.js");
  return { ...actual, getEmailProvider: () => ({ provider: { sendEmail: sendEmailMock }, fromName: "Sophie at Ark Health" }) };
});

const { processInboundSupportEmail, sendEmailStaffReply } = await import("./sophie-email-dispatch.service.js");
const { getOrCreateSupportEmailConversation, listSupportEmailMessages, appendSupportEmailMessage, updateSupportEmailConversationState } = await import(
  "./support-email-conversations.service.js"
);

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName: "Support", lastName: "Test", email: `support-email-dispatch-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-16" })
    .returning({ id: customersTable.id });
  return row.id;
}

function okResult(overrides: Partial<Extract<SophieTurnResult, { ok: true }>> = {}): SophieTurnResult {
  return {
    ok: true,
    action: "reply",
    reply: "Your order shipped this morning.",
    nextQuestion: "Anything else I can help with?",
    inboundSentiment: "neutral",
    requiresStaff: false,
    knowledgeTopicsUsed: [],
    source: "model",
    preCheckCode: null,
    ...overrides,
  };
}

describe("processInboundSupportEmail", () => {
  it("persists the inbound email, sends a combined reply+nextQuestion email threaded to it, and logs it", async () => {
    runSophieTurnMock.mockClear();
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<sophie-reply-1@example.com>" });
    runSophieTurnMock.mockResolvedValueOnce(okResult());

    const personId = await seedCustomer();
    const result = await processInboundSupportEmail(personId, "Where's my order?", "Has it shipped yet?", "<sophie-inbound-1@example.com>");

    expect(result.ok).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [, subject, html, opts] = sendEmailMock.mock.calls[0];
    expect(subject).toBe("Re: Where's my order?");
    expect(html).toContain("Your order shipped this morning.");
    expect(html).toContain("Anything else I can help with?");
    expect(opts.inReplyTo).toBe("<sophie-inbound-1@example.com>");

    const conversation = await getOrCreateSupportEmailConversation(personId);
    const messages = await listSupportEmailMessages(conversation.id);
    expect(messages.map((m) => m.direction)).toEqual(["inbound", "outbound"]);
    expect(messages[1].messageId).toBe("<sophie-reply-1@example.com>");
  });

  it("replies from the exact mailbox this customer's email arrived at, not the provider's default", async () => {
    runSophieTurnMock.mockClear();
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<sophie-reply-help@example.com>" });
    runSophieTurnMock.mockResolvedValueOnce(okResult());

    const personId = await seedCustomer();
    await processInboundSupportEmail(personId, "Refund status?", "Can you check on my refund?", "<sophie-inbound-help@example.com>", "help@example.com");

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [, , , opts] = sendEmailMock.mock.calls[0];
    expect(opts.fromEmailOverride).toBe("help@example.com");

    const conversation = await getOrCreateSupportEmailConversation(personId);
    expect(conversation.receivingAddress).toBe("help@example.com");
  });

  it("greets the customer by first name and signs off as Sophie — Claude's draft is only the substantive reply, not a full email", async () => {
    runSophieTurnMock.mockClear();
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<sophie-reply-2@example.com>" });
    runSophieTurnMock.mockResolvedValueOnce(okResult());

    // The greeting style is randomized (see withGreetingAndSignOff) — pin it
    // to the full "Hi <name>," style so this test stays deterministic.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const personId = await seedCustomer();
      await processInboundSupportEmail(personId, "Where's my order?", "Has it shipped yet?", "<sophie-inbound-2@example.com>");

      const [, , html] = sendEmailMock.mock.calls[0];
      expect(html).toContain("Hi Support,");
      expect(html).toContain("Sophie at Ark Health");

      const conversation = await getOrCreateSupportEmailConversation(personId);
      const messages = await listSupportEmailMessages(conversation.id);
      expect(messages[1].body).toContain("Hi Support,");
      expect(messages[1].body).toContain("— Sophie at Ark Health");
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("sends the OPT_OUT confirmation reply, then marks the customer DND — the confirmation itself is not blocked", async () => {
    runSophieTurnMock.mockClear();
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<sophie-optout-1@example.com>" });
    runSophieTurnMock.mockResolvedValueOnce(
      okResult({
        action: "pause",
        reply: "You've been unsubscribed and won't receive further messages. Reply HELP for help.",
        nextQuestion: null,
        source: "pre_check_block",
        preCheckCode: "OPT_OUT",
      }),
    );

    const personId = await seedCustomer();
    expect(await isCustomerEmailDnd(personId)).toBe(false);

    await processInboundSupportEmail(personId, "unsubscribe", "STOP", null);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(await isCustomerEmailDnd(personId)).toBe(true);
  });

  it("does not send anything to a customer who is already do-not-disturb", async () => {
    runSophieTurnMock.mockClear();
    sendEmailMock.mockClear();
    runSophieTurnMock.mockResolvedValueOnce(okResult());

    const personId = await seedCustomer();
    await setCustomerEmailDnd(personId, true);

    await processInboundSupportEmail(personId, "any update?", "any update on my order?", null);

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("does not send anything, but still persists the inbound message and flags for staff, when the guardrail rejects the turn", async () => {
    runSophieTurnMock.mockClear();
    sendEmailMock.mockClear();
    runSophieTurnMock.mockResolvedValueOnce({ ok: false, code: "PROHIBITED_CLINICAL" });

    const personId = await seedCustomer();
    const result = await processInboundSupportEmail(personId, "dosage", "what dosage am I on", null);

    expect(result.ok).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
    const conversation = await getOrCreateSupportEmailConversation(personId);
    expect(conversation.needsAttention).toBe(true);
  });
});

describe("sendEmailStaffReply", () => {
  it("threads off the most recent message, greets/signs off the body, sends, logs, and clears needsAttention", async () => {
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<staff-support-reply-1@example.com>" });

    // Pin the randomized greeting style — see the equivalent note above.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportEmailConversation(personId);
    await appendSupportEmailMessage(conversation.id, "inbound", "Order status", "Has it shipped?", { messageId: "<inbound-1@example.com>" });
    await updateSupportEmailConversationState(conversation.id, { needsAttention: true });

    const [customerRow] = await db.select({ email: customersTable.email }).from(customersTable).where(eq(customersTable.id, personId));
    const result = await sendEmailStaffReply(conversation.id, "It shipped this morning.", "staff@example.com");
    randomSpy.mockRestore();

    expect(result).toEqual({ sent: true });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [to, subject, html, opts] = sendEmailMock.mock.calls[0];
    expect(to).toBe(customerRow.email);
    expect(subject).toBe("Re: Order status");
    expect(html).toContain("It shipped this morning.");
    expect(html).toContain("Hi Support,");
    expect(html).toContain("— Sophie at Ark Health");
    expect(opts.inReplyTo).toBe("<inbound-1@example.com>");

    const messages = await listSupportEmailMessages(conversation.id);
    expect(messages.at(-1)).toMatchObject({ direction: "outbound", subject: "Re: Order status", messageId: "<staff-support-reply-1@example.com>" });

    const updated = await getOrCreateSupportEmailConversation(personId);
    expect(updated.needsAttention).toBe(false);
  });

  it("sends a staff reply from the same mailbox the conversation is anchored to", async () => {
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<staff-support-reply-help@example.com>" });

    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportEmailConversation(personId, "help@example.com");
    await appendSupportEmailMessage(conversation.id, "inbound", "Order status", "Has it shipped?", { messageId: "<inbound-help-2@example.com>" });

    await sendEmailStaffReply(conversation.id, "It shipped this morning.", "staff@example.com");

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [, , , opts] = sendEmailMock.mock.calls[0];
    expect(opts.fromEmailOverride).toBe("help@example.com");
  });

  it("returns not_found for an unknown conversation id", async () => {
    const result = await sendEmailStaffReply("00000000-0000-0000-0000-000000000000", "hi", "staff@example.com");
    expect(result).toEqual({ sent: false, reason: "not_found" });
  });

  it("logs the message with sent:false when the send fails, and does not clear needsAttention", async () => {
    sendEmailMock.mockClear();
    sendEmailMock.mockRejectedValueOnce(new Error("boom"));

    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportEmailConversation(personId);
    await updateSupportEmailConversationState(conversation.id, { needsAttention: true });

    const result = await sendEmailStaffReply(conversation.id, "Following up.", "staff@example.com");

    expect(result).toEqual({ sent: false, reason: "send_failed" });
    const messages = await listSupportEmailMessages(conversation.id);
    expect(messages.at(-1)).toMatchObject({ direction: "outbound", body: expect.stringContaining("Following up.") });

    const updated = await getOrCreateSupportEmailConversation(personId);
    expect(updated.needsAttention).toBe(true);
  });
});
