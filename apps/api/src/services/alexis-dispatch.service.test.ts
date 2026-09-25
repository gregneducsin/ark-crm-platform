import { recordSmsDeliveryReceipt, getSmsReplyWork } from "./sms-delivery.service.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, conversationsTable, conversationMessagesTable, objectionReengagementTriggersTable } from "@luma/db";
import type { AlexisTurnResult } from "./alexis-conversation.service.js";
import { isCustomerSmsDnd, setCustomerSmsDnd, setCustomerEmailDnd } from "./dnd.service.js";

const runAlexisTurnMock = vi.fn();
vi.mock("./alexis-conversation.service.js", async () => {
  const actual = await vi.importActual<typeof import("./alexis-conversation.service.js")>("./alexis-conversation.service.js");
  return { ...actual, runAlexisTurn: (...args: unknown[]) => runAlexisTurnMock(...args) };
});

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
});

const { processInboundMessage, resumeAlexisSms } = await import("./alexis-dispatch.service.js");
const { getOrCreateConversation, listMessages, appendMessage } = await import("./conversations.service.js");

async function seedCustomer(opts: { phone?: string | null; firstName?: string } = {}): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: opts.firstName ?? "Dispatch",
      lastName: "Test",
      email: `dispatch-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-15",
      phone: opts.phone === undefined ? "+15551230000" : opts.phone,
    })
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

beforeEach(() => { runAlexisTurnMock.mockReset(); sendMessageMock.mockReset(); });

describe("processInboundMessage", () => {
  it("continues after financing interest rather than flagging different plan questions", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    await appendMessage(conversation.id, "outbound", "Which plan length works best for you?", { deliveryStatus: "sent" });
    await appendMessage(conversation.id, "inbound", "Do you offer financing?", {});
    await appendMessage(conversation.id, "outbound", "Want to see the payment plan options?", { deliveryStatus: "sent" });
    runAlexisTurnMock.mockResolvedValueOnce(okResult({ reply: "Here are the payment options.", nextQuestion: "Which plan works best for you?" }));
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "financing-progress" });

    await processInboundMessage(personId, "Yes please");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect((await getOrCreateConversation(personId)).needsAttention).toBe(false);
  });

  it("persists the inbound message, tags its sentiment, and sends+logs both reply and nextQuestion", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_1" });
    runAlexisTurnMock.mockResolvedValueOnce(okResult({ inboundSentiment: "positive" }));

    const personId = await seedCustomer();
    const result = await processInboundMessage(personId, "How much is semaglutide?");

    expect(result.ok).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith("+15551230000", "Semaglutide starts at $120 for the 1-month plan.\n\nWhich plan are you considering?");

    const conversation = await getOrCreateConversation(personId);
    const messages = await listMessages(conversation.id);
    expect(messages.map((m) => ({ direction: m.direction, body: m.body }))).toEqual([
      { direction: "inbound", body: "How much is semaglutide?" },
      { direction: "outbound", body: "Semaglutide starts at $120 for the 1-month plan.\n\nWhich plan are you considering?" },
    ]);
    expect(messages[0].sentiment).toBe("positive");
    expect(messages[1].providerMessageId).toBe("msg_1");
    expect(messages[1].deliveryStatus).toBe("queued");
  });

  it("persists objectionKey alongside objectionStage", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_obj" });
    runAlexisTurnMock.mockResolvedValueOnce(okResult({ objectionKey: "price", objectionStage: 1 }));

    const personId = await seedCustomer();
    await processInboundMessage(personId, "still thinking about the cost");

    const conversation = await getOrCreateConversation(personId);
    const [row] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conversation.id));
    expect(row.objectionKey).toBe("price");
    expect(row.objectionStage).toBe(1);
  });

  it("schedules a 2-week re-engagement text once think_about_it reaches stand-down", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_standdown" });
    runAlexisTurnMock.mockResolvedValueOnce(okResult({ objectionKey: "think_about_it", objectionStage: 2, nextQuestion: null }));

    const personId = await seedCustomer();
    await processInboundMessage(personId, "nah I don't think I'm ready");

    const [trigger] = await db.select().from(objectionReengagementTriggersTable).where(eq(objectionReengagementTriggersTable.personId, personId));
    expect(trigger).toBeDefined();
    expect(trigger.status).toBe("pending");
  });

  it("schedules a 2-week re-engagement text once price reaches stand-down too — not just think_about_it", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_price_standdown" });
    runAlexisTurnMock.mockResolvedValueOnce(okResult({ objectionKey: "price", objectionStage: 2, nextQuestion: null }));

    const personId = await seedCustomer();
    await processInboundMessage(personId, "no thanks, still too much");

    const [trigger] = await db.select().from(objectionReengagementTriggersTable).where(eq(objectionReengagementTriggersTable.personId, personId));
    expect(trigger).toBeDefined();
    expect(trigger.status).toBe("pending");
  });

  it("does NOT schedule a re-engagement text for a different objection reaching stage 2, or think_about_it/price at an earlier stage", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_other" });

    const otherObjectionPersonId = await seedCustomer();
    runAlexisTurnMock.mockResolvedValueOnce(okResult({ objectionKey: "not_qualified", objectionStage: 2, nextQuestion: null }));
    await processInboundMessage(otherObjectionPersonId, "no thanks");
    let triggers = await db.select().from(objectionReengagementTriggersTable).where(eq(objectionReengagementTriggersTable.personId, otherObjectionPersonId));
    expect(triggers).toHaveLength(0);

    const earlyStagePersonId = await seedCustomer();
    runAlexisTurnMock.mockResolvedValueOnce(okResult({ objectionKey: "think_about_it", objectionStage: 0 }));
    await processInboundMessage(earlyStagePersonId, "let me think about it");
    triggers = await db.select().from(objectionReengagementTriggersTable).where(eq(objectionReengagementTriggersTable.personId, earlyStagePersonId));
    expect(triggers).toHaveLength(0);

    const earlyPricePersonId = await seedCustomer();
    runAlexisTurnMock.mockResolvedValueOnce(okResult({ objectionKey: "price", objectionStage: 1, nextQuestion: "What price were you hoping for?" }));
    await processInboundMessage(earlyPricePersonId, "too expensive");
    triggers = await db.select().from(objectionReengagementTriggersTable).where(eq(objectionReengagementTriggersTable.personId, earlyPricePersonId));
    expect(triggers).toHaveLength(0);
  });

  it("passes the customer's known first name to runAlexisTurn, and null for the 'Unknown' placeholder", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_x" });
    runAlexisTurnMock.mockResolvedValue(okResult());

    const knownPersonId = await seedCustomer({ firstName: "Jordan" });
    await processInboundMessage(knownPersonId, "hi");
    expect(runAlexisTurnMock.mock.calls[0]![1].customerFirstName).toBe("Jordan");

    runAlexisTurnMock.mockClear();
    const unknownPersonId = await seedCustomer({ firstName: "Unknown" });
    await processInboundMessage(unknownPersonId, "hi");
    expect(runAlexisTurnMock.mock.calls[0]![1].customerFirstName).toBeNull();
  });

  it("writes a name learned mid-conversation to the customer record once it was previously unknown", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_x" });
    runAlexisTurnMock.mockResolvedValueOnce(okResult({ learnedFirstName: "Jordan" }));

    const personId = await seedCustomer({ firstName: "Unknown" });
    await processInboundMessage(personId, "It's Jordan");

    const [customer] = await db.select({ firstName: customersTable.firstName }).from(customersTable).where(eq(customersTable.id, personId));
    expect(customer!.firstName).toBe("Jordan");
  });

  it("does not overwrite an already-known first name, even if runAlexisTurn reports one", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_x" });
    runAlexisTurnMock.mockResolvedValueOnce(okResult({ learnedFirstName: "SomeoneElse" }));

    const personId = await seedCustomer({ firstName: "Jordan" });
    await processInboundMessage(personId, "hi");

    const [customer] = await db.select({ firstName: customersTable.firstName }).from(customersTable).where(eq(customersTable.id, personId));
    expect(customer!.firstName).toBe("Jordan");
  });

  it("merges validatedSlotUpdates into conversation state and stores objectionStage/linkProvided/promoOffered", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_x" });
    runAlexisTurnMock.mockResolvedValueOnce(
      okResult({ objectionStage: 1, linkProvided: true, promoOffered: true, validatedSlotUpdates: { selectedProduct: "tirzepatide" } }),
    );

    const personId = await seedCustomer();
    await processInboundMessage(personId, "I'm interested in tirzepatide");

    const conversation = await getOrCreateConversation(personId);
    expect(conversation.selectedProduct).toBe("tirzepatide");
    expect(conversation.objectionStage).toBe(1);
    expect(conversation.linkProvided).toBe(true);
    expect(conversation.promoOffered).toBe(true);
    expect(conversation.lastQuestion).toBe("Which plan are you considering?");
  });

  it("merges the new planLength/dosagePreference/startTimingPreference slots into conversation state the same way", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_slots" });
    runAlexisTurnMock.mockResolvedValueOnce(
      okResult({ validatedSlotUpdates: { planLength: "3_month", dosagePreference: "7.5 mg", startTimingPreference: "ready_now" } }),
    );

    const personId = await seedCustomer();
    await processInboundMessage(personId, "let's do the 3 month plan, 7.5mg, I want to start now");

    const conversation = await getOrCreateConversation(personId);
    expect(conversation.planLength).toBe("3_month");
    expect(conversation.dosagePreference).toBe("7.5 mg");
    expect(conversation.startTimingPreference).toBe("ready_now");
  });

  it("still logs the outbound message when the SMS send itself fails, but without a providerMessageId", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockRejectedValueOnce(new Error("No SMS provider is configured (SMS_PROVIDER is unset)."));
    runAlexisTurnMock.mockResolvedValueOnce(okResult({ nextQuestion: null }));

    const personId = await seedCustomer();
    const result = await processInboundMessage(personId, "tell me more");

    expect(result.ok).toBe(true);
    const conversation = await getOrCreateConversation(personId);
    const messages = await listMessages(conversation.id);
    const outbound = messages.find((m) => m.direction === "outbound");
    expect(outbound).toBeDefined();
    expect(outbound?.providerMessageId).toBeNull();
  });

  it("does not send anything, but still persists the inbound message, when the customer has no phone on file", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    runAlexisTurnMock.mockResolvedValueOnce(okResult());

    const personId = await seedCustomer({ phone: null });
    await processInboundMessage(personId, "hello");

    expect(sendMessageMock).not.toHaveBeenCalled();
    const conversation = await getOrCreateConversation(personId);
    const messages = await listMessages(conversation.id);
    expect(messages.some((m) => m.direction === "inbound" && m.body === "hello")).toBe(true);
  });

  it("does not send or persist any outbound message when the guardrail rejects the turn, but flags the conversation for staff attention", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    runAlexisTurnMock.mockResolvedValueOnce({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });

    const personId = await seedCustomer();
    const result = await processInboundMessage(personId, "give me a discount");

    expect(result.ok).toBe(false);
    expect(sendMessageMock).not.toHaveBeenCalled();
    const conversation = await getOrCreateConversation(personId);
    const messages = await listMessages(conversation.id);
    expect(messages.length).toBe(1);
    expect(messages[0].direction).toBe("inbound");
    expect(conversation.needsAttention).toBe(true);
  });

  it("flags the conversation for staff attention and returns ok:false, instead of throwing, when runAlexisTurn itself throws unexpectedly", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    runAlexisTurnMock.mockRejectedValueOnce(new Error("createIntakeLink: connection terminated unexpectedly"));

    const personId = await seedCustomer();
    const result = await processInboundMessage(personId, "yes send me the link");

    expect(result).toEqual({ ok: false, code: "UNEXPECTED_ERROR" });
    expect(sendMessageMock).not.toHaveBeenCalled();
    const conversation = await getOrCreateConversation(personId);
    const messages = await listMessages(conversation.id);
    expect(messages.length).toBe(1);
    expect(messages[0].direction).toBe("inbound");
    expect(conversation.needsAttention).toBe(true);
  });

  it("flags the conversation for staff attention when the model itself flags requiresStaff (e.g. action=staff_review)", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    runAlexisTurnMock.mockResolvedValueOnce(
      okResult({ action: "staff_review", reply: null, nextQuestion: null, requiresStaff: true, source: "pre_check_block" }),
    );

    const personId = await seedCustomer();
    await processInboundMessage(personId, "I need to speak to a lawyer");

    const conversation = await getOrCreateConversation(personId);
    expect(conversation.needsAttention).toBe(true);
  });

  it("does not flag the conversation when the turn is a normal, non-staff reply", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_ok" });
    runAlexisTurnMock.mockResolvedValueOnce(okResult({ requiresStaff: false }));

    const personId = await seedCustomer();
    await processInboundMessage(personId, "how much is semaglutide?");

    const conversation = await getOrCreateConversation(personId);
    expect(conversation.needsAttention).toBe(false);
  });

  it("persists queued texts immediately, skips intermediate turns and discards an outdated draft", async () => {
    runAlexisTurnMock.mockReset();
    sendMessageMock.mockReset();
    sendMessageMock.mockResolvedValue({ providerMessageId: "fresh" });
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    runAlexisTurnMock.mockImplementationOnce(async () => {
      started();
      await gate;
      return okResult({ reply: "Outdated draft.", nextQuestion: "Old question?", validatedSlotUpdates: { state: "NY" }, learnedFirstName: "Wrong" });
    }).mockResolvedValue(okResult({ reply: "Answer to the latest concern.", nextQuestion: null }));
    const personId = await seedCustomer({ firstName: "Unknown" });
    const conversation = await getOrCreateConversation(personId);
    const first = processInboundMessage(personId, "First request");
    await entered;
    const second = processInboundMessage(personId, "More context");
    await vi.waitFor(async () => expect((await listMessages(conversation.id)).filter((m) => m.direction === "inbound")).toHaveLength(2));
    const third = processInboundMessage(personId, "Latest concern");
    await vi.waitFor(async () => expect((await listMessages(conversation.id)).filter((m) => m.direction === "inbound")).toHaveLength(3));
    release();
    const results = await Promise.all([first, second, third]);
    expect(results[0]).toEqual({ ok: false, code: "SUPERSEDED" });
    expect(results.slice(1).filter((result) => result.ok)).toHaveLength(1);
    expect(results.slice(1).filter((result) => !result.ok)).toHaveLength(1);
    expect(runAlexisTurnMock).toHaveBeenCalledTimes(2);
    const latestBody = runAlexisTurnMock.mock.calls[1][1];
    expect(latestBody.messages.filter((m: { direction: string }) => m.direction === "inbound").map((m: { body: string }) => m.body))
      .toEqual(["First request", "More context", "Latest concern"]);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][1]).toBe("Answer to the latest concern.");
    expect((await getOrCreateConversation(personId)).lastQuestion).toBeNull();
    expect((await getOrCreateConversation(personId)).state).toBeNull();
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, personId));
    expect(customer.firstName).toBe("Unknown");
  });

  it("retains a new inbound until the combined SMS has provider confirmation", async () => {
    runAlexisTurnMock.mockReset();
    sendMessageMock.mockReset();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const acceptedId = crypto.randomUUID();
    sendMessageMock.mockImplementationOnce(async () => {
      started();
      await gate;
      return { providerMessageId: acceptedId };
    }).mockResolvedValue({ providerMessageId: "latest" });
    runAlexisTurnMock.mockResolvedValueOnce(okResult({ reply: "First answer.", nextQuestion: "Obsolete question?" }))
      .mockResolvedValue(okResult({ reply: "Updated answer.", nextQuestion: null }));
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    const first = processInboundMessage(personId, "First request");
    await entered;
    const second = processInboundMessage(personId, "New request");
    await vi.waitFor(async () => expect((await listMessages(conversation.id)).filter((m) => m.direction === "inbound")).toHaveLength(2));
    release();
    await Promise.all([first, second]);
    expect(sendMessageMock.mock.calls.map((call) => call[1])).toEqual(["First answer.\n\nObsolete question?"]);
    expect(await getSmsReplyWork(personId, "sales")).toBeDefined();
    await recordSmsDeliveryReceipt(acceptedId, "sent", new Date());
    await resumeAlexisSms(personId);
    expect(sendMessageMock.mock.calls.map((call) => call[1])).toEqual(["First answer.\n\nObsolete question?", "Updated answer."]);
    expect(await getSmsReplyWork(personId, "sales")).toBeUndefined();
  });

  it("honors a queued STOP even when a newer text supersedes its turn", async () => {
    runAlexisTurnMock.mockReset();
    sendMessageMock.mockReset();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    runAlexisTurnMock.mockImplementationOnce(async () => {
      started();
      await gate;
      return okResult();
    }).mockResolvedValue(okResult());
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    const first = processInboundMessage(personId, "Hello");
    await entered;
    const stop = processInboundMessage(personId, "STOP");
    await vi.waitFor(async () => expect(await isCustomerSmsDnd(personId)).toBe(true));
    const latest = processInboundMessage(personId, "Thank you");
    await vi.waitFor(async () => expect((await listMessages(conversation.id)).filter((m) => m.direction === "inbound")).toHaveLength(3));
    release();
    await Promise.all([first, stop, latest]);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(await isCustomerSmsDnd(personId)).toBe(true);
  });

  it("does not create a duplicate conversation across multiple inbound turns", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_y" });
    runAlexisTurnMock.mockResolvedValue(okResult());

    const personId = await seedCustomer();
    await processInboundMessage(personId, "first");
    await processInboundMessage(personId, "second");

    const rows = await db.select().from(conversationsTable).where(eq(conversationsTable.personId, personId));
    expect(rows.length).toBe(1);
  });

  it("sends the OPT_OUT confirmation reply, then marks the customer DND — the confirmation itself is not blocked", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_optout" });
    runAlexisTurnMock.mockResolvedValueOnce(
      okResult({
        action: "pause",
        reply: "You've been unsubscribed and won't receive further messages. Reply HELP for help.",
        nextQuestion: null,
        requiresStaff: false,
        source: "pre_check_block",
        preCheckCode: "OPT_OUT",
      }),
    );

    const personId = await seedCustomer();
    expect(await isCustomerSmsDnd(personId)).toBe(false);

    await processInboundMessage(personId, "STOP");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith("+15551230000", "You've been unsubscribed and won't receive further messages. Reply HELP for help.");
    expect(await isCustomerSmsDnd(personId)).toBe(true);
  });

  it("does not send anything to a customer who is already do-not-disturb", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    runAlexisTurnMock.mockResolvedValueOnce(okResult());

    const personId = await seedCustomer();
    await setCustomerSmsDnd(personId, true);

    await processInboundMessage(personId, "how much is tirzepatide?");

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("still sends SMS when the customer is only email do-not-disturb — the two channels are independent", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_email_dnd_only" });
    runAlexisTurnMock.mockResolvedValueOnce(okResult({ nextQuestion: null }));

    const personId = await seedCustomer();
    await setCustomerEmailDnd(personId, true);

    await processInboundMessage(personId, "how much is tirzepatide?");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it("does not send anything, including replies, while sales SMS is paused", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    runAlexisTurnMock.mockResolvedValueOnce(okResult());

    const originalEnv = process.env.SALES_SMS_ENABLED;
    process.env.SALES_SMS_ENABLED = "false";
    try {
      const personId = await seedCustomer();
      await processInboundMessage(personId, "how much is semaglutide?");

      expect(sendMessageMock).not.toHaveBeenCalled();
      const conversation = await getOrCreateConversation(personId);
      const messages = await listMessages(conversation.id);
      // The inbound message is still recorded — only the outbound reply is suppressed.
      expect(messages.map((m) => m.direction)).toEqual(["inbound"]);
    } finally {
      if (originalEnv === undefined) delete process.env.SALES_SMS_ENABLED;
      else process.env.SALES_SMS_ENABLED = originalEnv;
    }
  });

  it("stops sending once 10 outbound messages have gone out to this person in the last 20 minutes — the send-burst cap", async () => {
    // Regression test for a real incident: a stream of fabricated inbound
    // webhook events (not a real customer, confirmed against the provider's
    // own records) drove 15+ real texts to one person in ~25 minutes, each
    // individually a legitimate guardrail-approved reply. This cap doesn't
    // care why the sends keep coming — only that they stop past the limit,
    // with a staff flag for the unanswered inbound.
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();

    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    for (let i = 0; i < 10; i++) {
      await appendMessage(conversation.id, "outbound", `prior message ${i}`, { deliveryStatus: "sent" });
    }

    runAlexisTurnMock.mockResolvedValueOnce(okResult());
    await processInboundMessage(personId, "are you still there?");

    expect(sendMessageMock).not.toHaveBeenCalled();
    const updated = await getOrCreateConversation(personId);
    expect(updated.needsAttention).toBe(true);
    expect(updated.needsAttentionReason).toMatch(/message limit/i);
  });

  it("still sends normally when under the send-burst cap", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_under_cap" });

    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    for (let i = 0; i < 8; i++) {
      await appendMessage(conversation.id, "outbound", `prior message ${i}`, { deliveryStatus: "sent" });
    }

    runAlexisTurnMock.mockResolvedValueOnce(okResult({ nextQuestion: null }));
    await processInboundMessage(personId, "still there?");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it("does not count outbound messages from outside the burst window", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_old_excluded" });

    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    for (let i = 0; i < 10; i++) {
      await db
        .insert(conversationMessagesTable)
        .values({ conversationId: conversation.id, direction: "outbound", body: `old message ${i}`, deliveryStatus: "sent", createdAt: new Date(Date.now() - 30 * 60 * 1000) });
    }

    runAlexisTurnMock.mockResolvedValueOnce(okResult({ nextQuestion: null }));
    await processInboundMessage(personId, "hello again");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it("stops auto-sending and flags the conversation once it's asked essentially the same question twice already, without waiting for a full 10-message burst", async () => {
    // Regression test for the real incident this fix targets (ported from
    // Luma): a customer kept answering a "which plan length" question in
    // different words, and the bot never recognized any of them as
    // resolving it, so it just kept re-asking a reworded version — this
    // should be caught well before the blunt send-burst cap would trigger.
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();

    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    await appendMessage(conversation.id, "outbound", "Would you like the 3-month plan or the 6-month plan?", { deliveryStatus: "sent" });
    await appendMessage(conversation.id, "inbound", "whatever you think is best honestly", {});
    await appendMessage(conversation.id, "outbound", "So just the 3-month plan or the 6-month plan?", { deliveryStatus: "sent" });

    runAlexisTurnMock.mockResolvedValueOnce(okResult({ reply: "Got it, thanks.", nextQuestion: "Should I set you up with the 3-month plan or the 6-month plan?" }));
    await processInboundMessage(personId, "I really don't have a preference");

    expect(sendMessageMock).not.toHaveBeenCalled();
    const updatedConversation = await getOrCreateConversation(personId);
    expect(updatedConversation.needsAttention).toBe(true);
    expect(updatedConversation.needsAttentionReason).toMatch(/same question/i);
  });

  it("sends normally when a question has only been asked once before, reworded — not yet a repeating streak", async () => {
    runAlexisTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_one_repeat" });

    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    await appendMessage(conversation.id, "outbound", "Would you like the 3-month plan or the 6-month plan?", { deliveryStatus: "sent" });

    runAlexisTurnMock.mockResolvedValueOnce(okResult({ reply: "Got it, thanks.", nextQuestion: "Should I set you up with the 3-month plan or the 6-month plan?" }));
    await processInboundMessage(personId, "hmm not sure yet");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const updatedConversation = await getOrCreateConversation(personId);
    expect(updatedConversation.needsAttention).toBe(false);
  });
});

describe("answer-only repeat escalation", () => {
  async function repeated() {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    const question = "Has your contact info or delivery address changed?";
    await appendMessage(conversation.id, "outbound", question, { deliveryStatus: "sent" });
    await appendMessage(conversation.id, "inbound", "No changes.", {});
    await appendMessage(conversation.id, "outbound", question, { deliveryStatus: "sent" });
    return { personId, conversation, question };
  }

  it("sends one useful answer without the repeated question and holds subsequent inbound", async () => {
    const { personId, conversation, question } = await repeated();
    const reply = "Your order is still under review with the doctor.";
    runAlexisTurnMock.mockResolvedValueOnce(okResult({ reply, nextQuestion: question }));
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "sales-answer-only" });
    const result = await processInboundMessage(personId, "What is my order status?");
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][1]).toBe(reply);
    expect(result).toMatchObject({ ok: true, nextQuestion: null, requiresStaff: true });
    expect(await getOrCreateConversation(personId)).toMatchObject({ needsAttention: true, lastQuestion: null, lastDraft: reply });
    expect((await getSmsReplyWork(personId, "sales"))?.heldForStaff).toBe(true);
    await recordSmsDeliveryReceipt("sales-answer-only", "sent", new Date());
    await processInboundMessage(personId, "And now?");
    expect(runAlexisTurnMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect((await listMessages(conversation.id)).at(-1)?.direction).toBe("inbound");
  });

  it("does not release a model staff escalation through answer-only handling", async () => {
    const { personId, question } = await repeated();
    runAlexisTurnMock.mockResolvedValueOnce(okResult({ requiresStaff: true, nextQuestion: question }));
    await processInboundMessage(personId, "Please help with my order.");
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect((await getOrCreateConversation(personId)).needsAttention).toBe(true);
    expect((await getSmsReplyWork(personId, "sales"))?.heldForStaff).toBe(true);
  });

  it("preserves a delivery-failure reason and never resends the answer", async () => {
    const { personId, question } = await repeated();
    runAlexisTurnMock.mockResolvedValueOnce(okResult({ reply: "Your order is still under review with the doctor.", nextQuestion: question }));
    sendMessageMock.mockRejectedValueOnce(new Error("synthetic transport failure"));
    await processInboundMessage(personId, "What is my order status?");
    expect((await getOrCreateConversation(personId)).needsAttentionReason).toMatch(/delivery.*unconfirmed or failed/i);
    expect((await getSmsReplyWork(personId, "sales"))?.heldForStaff).toBe(true);
    await processInboundMessage(personId, "Any update?");
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it("retains the staff hold when a newer inbound arrives during transport", async () => {
    const { personId, conversation, question } = await repeated();
    runAlexisTurnMock.mockResolvedValueOnce(okResult({ reply: "Your order is still under review with the doctor.", nextQuestion: question }));
    sendMessageMock.mockImplementationOnce(async () => {
      expect((await getSmsReplyWork(personId, "sales"))?.heldForStaff).toBe(true);
      const { recordSmsInbound } = await import("./sms-delivery.service.js");
      await recordSmsInbound(personId, "sales", conversation.id, "Another question.");
      return { providerMessageId: "sales-answer-race" };
    });
    await processInboundMessage(personId, "What is my order status?");
    expect((await getSmsReplyWork(personId, "sales"))?.heldForStaff).toBe(true);
    expect((await getOrCreateConversation(personId)).needsAttention).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });
});

describe("confirmed SMS timing", () => {
  it("keeps an early acknowledgment before the question that was sent later", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    const queuedAt = new Date(Date.now() - 60_000);
    const inboundAt = new Date(queuedAt.getTime() + 10_000);
    const sentAt = new Date(queuedAt.getTime() + 20_000);
    const id = crypto.randomUUID();
    await appendMessage(conversation.id, "outbound", "Synthetic explanation.\n\nWhich option interests you?", { deliveryStatus: "queued", providerMessageId: id, createdAt: queuedAt });
    runAlexisTurnMock.mockResolvedValue(okResult({ action: "no_reply", reply: null, nextQuestion: null }));
    await processInboundMessage(personId, "OK sounds good", undefined, undefined, { createdAt: inboundAt });
    expect(runAlexisTurnMock).not.toHaveBeenCalled();
    await recordSmsDeliveryReceipt(id, "sent", sentAt);
    await resumeAlexisSms(personId);
    const preview = runAlexisTurnMock.mock.calls[0][1];
    expect(preview.messages.map((m: { body: string }) => m.body)).toEqual(["OK sounds good", "Synthetic explanation.\n\nWhich option interests you?"]);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("applies STOP immediately while an outgoing text is queued", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    await appendMessage(conversation.id, "outbound", "Synthetic pending response", { deliveryStatus: "queued" });
    await processInboundMessage(personId, "STOP");
    expect(await isCustomerSmsDnd(personId)).toBe(true);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect((await listMessages(conversation.id)).some((m) => m.body === "STOP")).toBe(true);
  });
});
