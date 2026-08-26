import { describe, expect, it, vi, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";
import type { AlexisTurnResult } from "./alexis-conversation.service.js";
import { isCustomerEmailDnd, setCustomerEmailDnd, setCustomerSmsDnd } from "./dnd.service.js";

beforeAll(() => {
  process.env.EMAIL_PROVIDER = "google_workspace";
  process.env.GOOGLE_WORKSPACE_SMTP_USER = "bot@example.com";
  process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD = "app-password";
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-secret";
  process.env.INTAKE_LINK_BASE_URL = "http://localhost:3000";
});

const runAlexisTurnMock = vi.fn();
vi.mock("./alexis-conversation.service.js", async () => {
  const actual = await vi.importActual<typeof import("./alexis-conversation.service.js")>("./alexis-conversation.service.js");
  return { ...actual, runAlexisTurn: (...args: unknown[]) => runAlexisTurnMock(...args) };
});

const sendEmailMock = vi.fn();
vi.mock("../lib/email-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/email-provider.js")>("../lib/email-provider.js");
  return { ...actual, getEmailProvider: () => ({ provider: { sendEmail: sendEmailMock }, fromName: "Alexis at Ark Health" }) };
});

const { processInboundEmail, sendEmailStaffReply } = await import("./alexis-email-dispatch.service.js");
const { getOrCreateEmailConversation, listEmailMessages, appendEmailMessage, updateEmailConversationState } = await import("./email-conversations.service.js");

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName: "Email", lastName: "Test", email: `email-dispatch-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" })
    .returning({ id: customersTable.id });
  return row.id;
}

function okResult(overrides: Partial<Extract<AlexisTurnResult, { ok: true }>> = {}): AlexisTurnResult {
  return {
    ok: true,
    action: "reply",
    reply: "Semaglutide starts at $120 for the 1-month plan.",
    nextQuestion: "Which plan are you considering?",
    link: null,
    objectionStage: 0,
    objectionKey: null,
    linkProvided: false,
    promoOffered: false,
    inboundSentiment: "neutral",
    requiresStaff: false,
    knowledgeTopicsUsed: ["semaglutide_pricing"],
    validatedSlotUpdates: {},
    source: "model",
    preCheckCode: null,
    learnedFirstName: null,
    ...overrides,
  };
}

describe("processInboundEmail", () => {
  it("persists the inbound email, sends a combined reply+nextQuestion email threaded to it, and logs it", async () => {
    runAlexisTurnMock.mockClear();
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<reply-1@example.com>" });
    runAlexisTurnMock.mockResolvedValueOnce(okResult());

    const personId = await seedCustomer();
    const result = await processInboundEmail(personId, "Question about pricing", "How much is semaglutide?", "<inbound-1@example.com>");

    expect(result.ok).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [, subject, html, opts] = sendEmailMock.mock.calls[0];
    expect(subject).toBe("Re: Question about pricing");
    expect(html).toContain("Semaglutide starts at $120");
    expect(html).toContain("Which plan are you considering?");
    expect(opts.inReplyTo).toBe("<inbound-1@example.com>");

    const conversation = await getOrCreateEmailConversation(personId);
    const messages = await listEmailMessages(conversation.id);
    expect(messages.map((m) => m.direction)).toEqual(["inbound", "outbound"]);
    expect(messages[1].messageId).toBe("<reply-1@example.com>");
    expect(messages[1].inReplyTo).toBe("<inbound-1@example.com>");
  });

  it("replies from the exact mailbox this customer's email arrived at, not the provider's default", async () => {
    runAlexisTurnMock.mockClear();
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<reply-help@example.com>" });
    runAlexisTurnMock.mockResolvedValueOnce(okResult());

    const personId = await seedCustomer();
    await processInboundEmail(personId, "Question", "Do you ship to Texas?", "<inbound-help@example.com>", undefined, "help@example.com");

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [, , , opts] = sendEmailMock.mock.calls[0];
    expect(opts.fromEmailOverride).toBe("help@example.com");

    const conversation = await getOrCreateEmailConversation(personId);
    expect(conversation.receivingAddress).toBe("help@example.com");
  });

  it("updates the receiving mailbox — and replies from the new one — when the same customer later writes to a different address", async () => {
    runAlexisTurnMock.mockClear();
    sendEmailMock.mockClear();
    runAlexisTurnMock.mockResolvedValueOnce(okResult());
    sendEmailMock.mockResolvedValueOnce({ messageId: "<first@example.com>" });

    const personId = await seedCustomer();
    await processInboundEmail(personId, "Q1", "First message", "<m1@example.com>", undefined, "help@example.com");
    expect((await getOrCreateEmailConversation(personId)).receivingAddress).toBe("help@example.com");

    runAlexisTurnMock.mockResolvedValueOnce(okResult());
    sendEmailMock.mockResolvedValueOnce({ messageId: "<second@example.com>" });
    await processInboundEmail(personId, "Q2", "Second message", "<m2@example.com>", undefined, "support@example.com");

    const [, , , opts] = sendEmailMock.mock.calls[1];
    expect(opts.fromEmailOverride).toBe("support@example.com");
    expect((await getOrCreateEmailConversation(personId)).receivingAddress).toBe("support@example.com");
  });

  it("schedules a 2-week re-engagement text once think_about_it reaches stand-down over email too", async () => {
    runAlexisTurnMock.mockClear();
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<reply-standdown@example.com>" });
    runAlexisTurnMock.mockResolvedValueOnce(okResult({ objectionKey: "think_about_it", objectionStage: 2, nextQuestion: null }));

    const personId = await seedCustomer();
    await processInboundEmail(personId, "Question about pricing", "not sure I'm ready yet", "<inbound-standdown@example.com>");

    const { db, objectionReengagementTriggersTable } = await import("@luma/db");
    const { eq } = await import("drizzle-orm");
    const [trigger] = await db.select().from(objectionReengagementTriggersTable).where(eq(objectionReengagementTriggersTable.personId, personId));
    expect(trigger).toBeDefined();
    expect(trigger.status).toBe("pending");
  });

  it("greets the customer by first name and signs off as Alexis — Claude's draft is only the substantive reply, not a full email", async () => {
    runAlexisTurnMock.mockClear();
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<reply-2@example.com>" });
    runAlexisTurnMock.mockResolvedValueOnce(okResult());

    // The greeting style is randomized (see withGreetingAndSignOff) — pin it
    // to the full "Hi <name>," style so this test stays deterministic.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const personId = await seedCustomer();
      await processInboundEmail(personId, "Question about pricing", "How much is semaglutide?", "<inbound-2@example.com>");

      const [, , html] = sendEmailMock.mock.calls[0];
      expect(html).toContain("Hi Email,");
      expect(html).toContain("Alexis at Ark Health");

      const conversation = await getOrCreateEmailConversation(personId);
      const messages = await listEmailMessages(conversation.id);
      expect(messages[1].body).toContain("Hi Email,");
      expect(messages[1].body).toContain("— Alexis at Ark Health");
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("does not double 'Re:' when the inbound subject already has one", async () => {
    runAlexisTurnMock.mockClear();
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<reply-2@example.com>" });
    runAlexisTurnMock.mockResolvedValueOnce(okResult());

    const personId = await seedCustomer();
    await processInboundEmail(personId, "Re: Question about pricing", "Tell me more", null);

    const [, subject] = sendEmailMock.mock.calls[0];
    expect(subject).toBe("Re: Question about pricing");
  });

  it("sends the OPT_OUT confirmation reply, then marks the customer DND — the confirmation itself is not blocked", async () => {
    runAlexisTurnMock.mockClear();
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<optout-1@example.com>" });
    runAlexisTurnMock.mockResolvedValueOnce(
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

    await processInboundEmail(personId, "unsubscribe me", "STOP", null);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(await isCustomerEmailDnd(personId)).toBe(true);
  });

  it("does not send anything to a customer who is already do-not-disturb", async () => {
    runAlexisTurnMock.mockClear();
    sendEmailMock.mockClear();
    runAlexisTurnMock.mockResolvedValueOnce(okResult());

    const personId = await seedCustomer();
    await setCustomerEmailDnd(personId, true);

    await processInboundEmail(personId, "still interested", "is this still $120?", null);

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("does not send anything, but still persists the inbound message and flags for staff, when the guardrail rejects the turn", async () => {
    runAlexisTurnMock.mockClear();
    sendEmailMock.mockClear();
    runAlexisTurnMock.mockResolvedValueOnce({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });

    const personId = await seedCustomer();
    const result = await processInboundEmail(personId, "discount?", "give me a discount", null);

    expect(result.ok).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
    const conversation = await getOrCreateEmailConversation(personId);
    expect(conversation.needsAttention).toBe(true);
  });

  it("still sends email when the customer is only SMS do-not-disturb — the two channels are independent", async () => {
    runAlexisTurnMock.mockClear();
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<sms-dnd-only@example.com>" });
    runAlexisTurnMock.mockResolvedValueOnce(okResult());

    const personId = await seedCustomer();
    await setCustomerSmsDnd(personId, true);

    await processInboundEmail(personId, "still interested?", "is this still $120?", null);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});

describe("sendEmailStaffReply", () => {
  it("threads off the most recent message, greets/signs off the body, sends, logs, and clears needsAttention", async () => {
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<staff-reply-1@example.com>" });

    // Pin the randomized greeting style — see the equivalent note above.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

    const personId = await seedCustomer();
    const conversation = await getOrCreateEmailConversation(personId);
    await appendEmailMessage(conversation.id, "inbound", "Pricing question", "How much is tirzepatide?", { messageId: "<inbound-1@example.com>" });
    await updateEmailConversationState(conversation.id, { needsAttention: true });

    const [customerRow] = await db.select({ email: customersTable.email }).from(customersTable).where(eq(customersTable.id, personId));
    const result = await sendEmailStaffReply(conversation.id, "It's $180/month for the standard plan.", "staff@example.com");
    randomSpy.mockRestore();

    expect(result).toEqual({ sent: true });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [to, subject, html, opts] = sendEmailMock.mock.calls[0];
    expect(to).toBe(customerRow.email);
    expect(subject).toBe("Re: Pricing question");
    expect(html).toContain("It's $180/month for the standard plan.");
    expect(html).toContain("Hi Email,");
    expect(html).toContain("— Alexis at Ark Health");
    expect(opts.inReplyTo).toBe("<inbound-1@example.com>");

    const messages = await listEmailMessages(conversation.id);
    expect(messages.at(-1)).toMatchObject({ direction: "outbound", subject: "Re: Pricing question", messageId: "<staff-reply-1@example.com>" });

    const updated = await getOrCreateEmailConversation(personId);
    expect(updated.needsAttention).toBe(false);
  });

  it("sends a staff reply from the same mailbox the conversation is anchored to", async () => {
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<staff-reply-help@example.com>" });

    const personId = await seedCustomer();
    const conversation = await getOrCreateEmailConversation(personId, undefined, "help@example.com");
    await appendEmailMessage(conversation.id, "inbound", "Question", "Are you open weekends?", { messageId: "<inbound-help-2@example.com>" });

    await sendEmailStaffReply(conversation.id, "Yes, we're open weekends.", "staff@example.com");

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
    const conversation = await getOrCreateEmailConversation(personId);
    await updateEmailConversationState(conversation.id, { needsAttention: true });

    const result = await sendEmailStaffReply(conversation.id, "Following up.", "staff@example.com");

    expect(result).toEqual({ sent: false, reason: "send_failed" });
    const messages = await listEmailMessages(conversation.id);
    expect(messages.at(-1)).toMatchObject({ direction: "outbound", body: expect.stringContaining("Following up.") });

    const updated = await getOrCreateEmailConversation(personId);
    expect(updated.needsAttention).toBe(true);
  });
});
