import { recordSmsDeliveryReceipt, getSmsReplyWork } from "./sms-delivery.service.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, supportConversationsTable, supportConversationMessagesTable } from "@luma/db";
import type { SophieTurnResult } from "./sophie-conversation.service.js";
import { isCustomerSmsDnd, setCustomerSmsDnd } from "./dnd.service.js";

const runSophieTurnMock = vi.fn();
vi.mock("./sophie-conversation.service.js", async () => {
  const actual = await vi.importActual<typeof import("./sophie-conversation.service.js")>("./sophie-conversation.service.js");
  return { ...actual, runSophieTurn: (...args: unknown[]) => runSophieTurnMock(...args) };
});

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
});

const { processInboundSupportMessage, resumeSophieSms } = await import("./sophie-dispatch.service.js");
const { getOrCreateSupportConversation, listSupportMessages, appendSupportMessage } = await import("./support-conversations.service.js");

async function seedCustomer(opts: { phone?: string | null } = {}): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "Dispatch",
      lastName: "Support",
      email: `support-dispatch-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-16",
      phone: opts.phone === undefined ? "+15551230001" : opts.phone,
    })
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

beforeEach(() => { runSophieTurnMock.mockReset(); sendMessageMock.mockReset(); });

describe("processInboundSupportMessage", () => {
  it("does not carry an old repeat streak past a completed answer", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    const question = "Would you like a refund or store credit for the return?";
    await appendSupportMessage(conversation.id, "outbound", question, { deliveryStatus: "sent" });
    await appendSupportMessage(conversation.id, "outbound", question, { deliveryStatus: "sent" });
    await appendSupportMessage(conversation.id, "inbound", "Please explain store credit.", {});
    await appendSupportMessage(conversation.id, "outbound", "Store credit can be used on a future order.", { deliveryStatus: "sent" });
    runSophieTurnMock.mockResolvedValueOnce(okResult({ nextQuestion: question }));
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "support-progress" });

    await processInboundSupportMessage(personId, "Thanks, that helps.");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect((await getOrCreateSupportConversation(personId)).needsAttention).toBe(false);
  });

  it("persists the inbound message, tags its sentiment, and sends+logs both reply and nextQuestion", async () => {
    runSophieTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_1" });
    runSophieTurnMock.mockResolvedValueOnce(okResult({ inboundSentiment: "positive" }));

    const personId = await seedCustomer();
    const result = await processInboundSupportMessage(personId, "Has my order shipped?");

    expect(result.ok).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith("+15551230001", "Your order shipped this morning.\n\nAnything else I can help with?");

    const conversation = await getOrCreateSupportConversation(personId);
    const messages = await listSupportMessages(conversation.id);
    expect(messages.map((m) => ({ direction: m.direction, body: m.body }))).toEqual([
      { direction: "inbound", body: "Has my order shipped?" },
      { direction: "outbound", body: "Your order shipped this morning.\n\nAnything else I can help with?" },
    ]);
    expect(messages[0].sentiment).toBe("positive");
  });

  it("still logs the outbound message when the SMS send itself fails, but without a providerMessageId", async () => {
    runSophieTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockRejectedValueOnce(new Error("No SMS provider is configured (SMS_PROVIDER is unset)."));
    runSophieTurnMock.mockResolvedValueOnce(okResult({ nextQuestion: null }));

    const personId = await seedCustomer();
    const result = await processInboundSupportMessage(personId, "tell me more");

    expect(result.ok).toBe(true);
    const conversation = await getOrCreateSupportConversation(personId);
    const messages = await listSupportMessages(conversation.id);
    const outbound = messages.find((m) => m.direction === "outbound");
    expect(outbound).toBeDefined();
    expect(outbound?.providerMessageId).toBeNull();
  });

  it("does not send anything, but still persists the inbound message, when the customer has no phone on file", async () => {
    runSophieTurnMock.mockClear();
    sendMessageMock.mockClear();
    runSophieTurnMock.mockResolvedValueOnce(okResult());

    const personId = await seedCustomer({ phone: null });
    await processInboundSupportMessage(personId, "hello");

    expect(sendMessageMock).not.toHaveBeenCalled();
    const conversation = await getOrCreateSupportConversation(personId);
    const messages = await listSupportMessages(conversation.id);
    expect(messages.some((m) => m.direction === "inbound" && m.body === "hello")).toBe(true);
  });

  it("does not send or persist any outbound message when the guardrail rejects the turn, but flags the conversation for staff attention", async () => {
    runSophieTurnMock.mockClear();
    sendMessageMock.mockClear();
    runSophieTurnMock.mockResolvedValueOnce({ ok: false, code: "PROHIBITED_CLINICAL" });

    const personId = await seedCustomer();
    const result = await processInboundSupportMessage(personId, "what dose am I on");

    expect(result.ok).toBe(false);
    expect(sendMessageMock).not.toHaveBeenCalled();
    const conversation = await getOrCreateSupportConversation(personId);
    const messages = await listSupportMessages(conversation.id);
    expect(messages.length).toBe(1);
    expect(messages[0].direction).toBe("inbound");
    expect(conversation.needsAttention).toBe(true);
  });

  it("flags the conversation for staff attention and returns ok:false, instead of throwing, when runSophieTurn itself throws unexpectedly", async () => {
    runSophieTurnMock.mockClear();
    sendMessageMock.mockClear();
    runSophieTurnMock.mockRejectedValueOnce(new Error("unexpected failure"));

    const personId = await seedCustomer();
    const result = await processInboundSupportMessage(personId, "has my order shipped");

    expect(result).toEqual({ ok: false, code: "UNEXPECTED_ERROR" });
    expect(sendMessageMock).not.toHaveBeenCalled();
    const conversation = await getOrCreateSupportConversation(personId);
    const messages = await listSupportMessages(conversation.id);
    expect(messages.length).toBe(1);
    expect(messages[0].direction).toBe("inbound");
    expect(conversation.needsAttention).toBe(true);
  });

  it("flags the conversation for staff attention when the model itself flags requiresStaff", async () => {
    runSophieTurnMock.mockClear();
    sendMessageMock.mockClear();
    runSophieTurnMock.mockResolvedValueOnce(
      okResult({ action: "staff_review", reply: null, nextQuestion: null, requiresStaff: true, source: "pre_check_block" }),
    );

    const personId = await seedCustomer();
    await processInboundSupportMessage(personId, "I need to speak to a lawyer");

    const conversation = await getOrCreateSupportConversation(personId);
    expect(conversation.needsAttention).toBe(true);
  });

  it("does not flag the conversation when the turn is a normal, non-staff reply", async () => {
    runSophieTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_ok" });
    runSophieTurnMock.mockResolvedValueOnce(okResult({ requiresStaff: false }));

    const personId = await seedCustomer();
    await processInboundSupportMessage(personId, "when will it ship");

    const conversation = await getOrCreateSupportConversation(personId);
    expect(conversation.needsAttention).toBe(false);
  });

  it("records reviewSentiment when the review check-in has already been sent and the model tags a sentiment", async () => {
    runSophieTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_review" });
    runSophieTurnMock.mockResolvedValueOnce(okResult({ inboundSentiment: "positive" }));

    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    await db.update(supportConversationsTable).set({ reviewRequested: true }).where(eq(supportConversationsTable.id, conversation.id));

    await processInboundSupportMessage(personId, "It's been great!");

    const updated = await getOrCreateSupportConversation(personId);
    expect(updated.reviewSentiment).toBe("positive");
  });

  it("persists queued texts immediately, skips intermediate turns and discards an outdated draft", async () => {
    runSophieTurnMock.mockReset();
    sendMessageMock.mockReset();
    sendMessageMock.mockResolvedValue({ providerMessageId: "fresh" });
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    runSophieTurnMock.mockImplementationOnce(async () => {
      started();
      await gate;
      return okResult({ reply: "Outdated draft.", nextQuestion: "Old question?" });
    }).mockResolvedValue(okResult({ reply: "Answer to the latest concern.", nextQuestion: null }));
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    const first = processInboundSupportMessage(personId, "First request");
    await entered;
    const second = processInboundSupportMessage(personId, "More context");
    await vi.waitFor(async () => expect((await listSupportMessages(conversation.id)).filter((m) => m.direction === "inbound")).toHaveLength(2));
    const third = processInboundSupportMessage(personId, "Latest concern");
    await vi.waitFor(async () => expect((await listSupportMessages(conversation.id)).filter((m) => m.direction === "inbound")).toHaveLength(3));
    release();
    const results = await Promise.all([first, second, third]);
    expect(results[0]).toEqual({ ok: false, code: "SUPERSEDED" });
    expect(results.slice(1).filter((result) => result.ok)).toHaveLength(1);
    expect(results.slice(1).filter((result) => !result.ok)).toHaveLength(1);
    expect(runSophieTurnMock).toHaveBeenCalledTimes(2);
    const latestBody = runSophieTurnMock.mock.calls[1][0];
    expect(latestBody.messages.filter((m: { direction: string }) => m.direction === "inbound").map((m: { body: string }) => m.body))
      .toEqual(["First request", "More context", "Latest concern"]);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][1]).toBe("Answer to the latest concern.");
    expect((await getOrCreateSupportConversation(personId)).lastQuestion).toBeNull();
    
  });

  it("retains a new inbound until the combined SMS has provider confirmation", async () => {
    runSophieTurnMock.mockReset();
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
    runSophieTurnMock.mockResolvedValueOnce(okResult({ reply: "First answer.", nextQuestion: "Obsolete question?" }))
      .mockResolvedValue(okResult({ reply: "Updated answer.", nextQuestion: null }));
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    const first = processInboundSupportMessage(personId, "First request");
    await entered;
    const second = processInboundSupportMessage(personId, "New request");
    await vi.waitFor(async () => expect((await listSupportMessages(conversation.id)).filter((m) => m.direction === "inbound")).toHaveLength(2));
    release();
    await Promise.all([first, second]);
    expect(sendMessageMock.mock.calls.map((call) => call[1])).toEqual(["First answer.\n\nObsolete question?"]);
    expect(await getSmsReplyWork(personId, "support")).toBeDefined();
    await recordSmsDeliveryReceipt(acceptedId, "sent", new Date());
    await resumeSophieSms(personId);
    expect(sendMessageMock.mock.calls.map((call) => call[1])).toEqual(["First answer.\n\nObsolete question?", "Updated answer."]);
    expect(await getSmsReplyWork(personId, "support")).toBeUndefined();
  });

  it("honors a queued STOP even when a newer text supersedes its turn", async () => {
    runSophieTurnMock.mockReset();
    sendMessageMock.mockReset();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    runSophieTurnMock.mockImplementationOnce(async () => {
      started();
      await gate;
      return okResult();
    }).mockResolvedValue(okResult());
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    const first = processInboundSupportMessage(personId, "Hello");
    await entered;
    const stop = processInboundSupportMessage(personId, "STOP");
    await vi.waitFor(async () => expect(await isCustomerSmsDnd(personId)).toBe(true));
    const latest = processInboundSupportMessage(personId, "Thank you");
    await vi.waitFor(async () => expect((await listSupportMessages(conversation.id)).filter((m) => m.direction === "inbound")).toHaveLength(3));
    release();
    await Promise.all([first, stop, latest]);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(await isCustomerSmsDnd(personId)).toBe(true);
  });

  it("does not create a duplicate conversation across multiple inbound turns", async () => {
    runSophieTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_y" });
    runSophieTurnMock.mockResolvedValue(okResult());

    const personId = await seedCustomer();
    await processInboundSupportMessage(personId, "first");
    await processInboundSupportMessage(personId, "second");

    const rows = await db.select().from(supportConversationsTable).where(eq(supportConversationsTable.personId, personId));
    expect(rows.length).toBe(1);
  });

  it("sends the OPT_OUT confirmation reply, then marks the customer DND — the confirmation itself is not blocked", async () => {
    runSophieTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_optout" });
    runSophieTurnMock.mockResolvedValueOnce(
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

    await processInboundSupportMessage(personId, "STOP");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith("+15551230001", "You've been unsubscribed and won't receive further messages. Reply HELP for help.");
    expect(await isCustomerSmsDnd(personId)).toBe(true);
  });

  it("does not send anything to a customer who is already do-not-disturb", async () => {
    runSophieTurnMock.mockClear();
    sendMessageMock.mockClear();
    runSophieTurnMock.mockResolvedValueOnce(okResult());

    const personId = await seedCustomer();
    await setCustomerSmsDnd(personId, true);

    await processInboundSupportMessage(personId, "any update on my order?");

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("stops sending once 10 outbound messages have gone out to this person in the last 20 minutes — the send-burst cap", async () => {
    runSophieTurnMock.mockClear();
    sendMessageMock.mockClear();

    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    for (let i = 0; i < 10; i++) {
      await appendSupportMessage(conversation.id, "outbound", `prior message ${i}`, { deliveryStatus: "sent" });
    }

    runSophieTurnMock.mockResolvedValueOnce(okResult());
    await processInboundSupportMessage(personId, "are you still there?");

    expect(sendMessageMock).not.toHaveBeenCalled();
    const updated = await getOrCreateSupportConversation(personId);
    expect(updated.needsAttention).toBe(true);
    expect(updated.needsAttentionReason).toMatch(/message limit/i);
  });

  it("does not count outbound messages from outside the burst window", async () => {
    runSophieTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_old_excluded" });

    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    for (let i = 0; i < 10; i++) {
      await db
        .insert(supportConversationMessagesTable)
        .values({ conversationId: conversation.id, direction: "outbound", body: `old message ${i}`, deliveryStatus: "sent", createdAt: new Date(Date.now() - 30 * 60 * 1000) });
    }

    runSophieTurnMock.mockResolvedValueOnce(okResult({ nextQuestion: null }));
    await processInboundSupportMessage(personId, "hello again");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it("stops auto-sending and flags the conversation once it's asked essentially the same question twice already, without waiting for a full 10-message burst", async () => {
    runSophieTurnMock.mockClear();
    sendMessageMock.mockClear();

    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    await appendSupportMessage(conversation.id, "outbound", "Would you like a refund or store credit for the return?", { deliveryStatus: "sent" });
    await appendSupportMessage(conversation.id, "inbound", "I'm not sure honestly", {});
    await appendSupportMessage(conversation.id, "outbound", "So just to confirm, refund or store credit for the return?", { deliveryStatus: "sent" });

    runSophieTurnMock.mockResolvedValueOnce(okResult({ reply: "Got it, thanks.", nextQuestion: "Should I go with a refund or store credit for the return?" }));
    await processInboundSupportMessage(personId, "whatever is easier for you honestly");

    expect(sendMessageMock).not.toHaveBeenCalled();
    const updatedConversation = await getOrCreateSupportConversation(personId);
    expect(updatedConversation.needsAttention).toBe(true);
    expect(updatedConversation.needsAttentionReason).toMatch(/same question/i);
  });

  it("sends normally when a question has only been asked once before, reworded — not yet a repeating streak", async () => {
    runSophieTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_one_repeat" });

    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    await appendSupportMessage(conversation.id, "outbound", "Would you like a refund or store credit for the return?", { deliveryStatus: "sent" });

    runSophieTurnMock.mockResolvedValueOnce(okResult({ reply: "Got it, thanks.", nextQuestion: "Should I go with a refund or store credit for the return?" }));
    await processInboundSupportMessage(personId, "hmm let me think");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const updatedConversation = await getOrCreateSupportConversation(personId);
    expect(updatedConversation.needsAttention).toBe(false);
  });
});

describe("answer-only repeat escalation", () => {
  async function repeated() {
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    const question = "Has your contact info or delivery address changed?";
    await appendSupportMessage(conversation.id, "outbound", question, { deliveryStatus: "sent" });
    await appendSupportMessage(conversation.id, "inbound", "No changes.", {});
    await appendSupportMessage(conversation.id, "outbound", question, { deliveryStatus: "sent" });
    return { personId, conversation, question };
  }

  it("sends one useful answer without the repeated question and holds subsequent inbound", async () => {
    const { personId, conversation, question } = await repeated();
    const reply = "Your order is still under review with the doctor.";
    runSophieTurnMock.mockResolvedValueOnce(okResult({ reply, nextQuestion: question }));
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "support-answer-only" });
    const result = await processInboundSupportMessage(personId, "What is my order status?");
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][1]).toBe(reply);
    expect(result).toMatchObject({ ok: true, nextQuestion: null, requiresStaff: true });
    expect(await getOrCreateSupportConversation(personId)).toMatchObject({ needsAttention: true, lastQuestion: null, lastDraft: reply });
    expect((await getSmsReplyWork(personId, "support"))?.heldForStaff).toBe(true);
    await recordSmsDeliveryReceipt("support-answer-only", "sent", new Date());
    await processInboundSupportMessage(personId, "And now?");
    expect(runSophieTurnMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect((await listSupportMessages(conversation.id)).at(-1)?.direction).toBe("inbound");
  });

  it("does not release a model staff escalation through answer-only handling", async () => {
    const { personId, question } = await repeated();
    runSophieTurnMock.mockResolvedValueOnce(okResult({ requiresStaff: true, nextQuestion: question }));
    await processInboundSupportMessage(personId, "Please help with my order.");
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect((await getOrCreateSupportConversation(personId)).needsAttention).toBe(true);
    expect((await getSmsReplyWork(personId, "support"))?.heldForStaff).toBe(true);
  });

  it("preserves a delivery-failure reason and never resends the answer", async () => {
    const { personId, question } = await repeated();
    runSophieTurnMock.mockResolvedValueOnce(okResult({ reply: "Your order is still under review with the doctor.", nextQuestion: question }));
    sendMessageMock.mockRejectedValueOnce(new Error("synthetic transport failure"));
    await processInboundSupportMessage(personId, "What is my order status?");
    expect((await getOrCreateSupportConversation(personId)).needsAttentionReason).toMatch(/delivery.*unconfirmed or failed/i);
    expect((await getSmsReplyWork(personId, "support"))?.heldForStaff).toBe(true);
    await processInboundSupportMessage(personId, "Any update?");
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it("retains the staff hold when a newer inbound arrives during transport", async () => {
    const { personId, conversation, question } = await repeated();
    runSophieTurnMock.mockResolvedValueOnce(okResult({ reply: "Your order is still under review with the doctor.", nextQuestion: question }));
    sendMessageMock.mockImplementationOnce(async () => {
      expect((await getSmsReplyWork(personId, "support"))?.heldForStaff).toBe(true);
      const { recordSmsInbound } = await import("./sms-delivery.service.js");
      await recordSmsInbound(personId, "support", conversation.id, "Another question.");
      return { providerMessageId: "support-answer-race" };
    });
    await processInboundSupportMessage(personId, "What is my order status?");
    expect((await getSmsReplyWork(personId, "support"))?.heldForStaff).toBe(true);
    expect((await getOrCreateSupportConversation(personId)).needsAttention).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });
});

describe("confirmed SMS timing", () => {
  it("keeps an early acknowledgment before the question that was sent later", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    const queuedAt = new Date(Date.now() - 60_000);
    const inboundAt = new Date(queuedAt.getTime() + 10_000);
    const sentAt = new Date(queuedAt.getTime() + 20_000);
    const id = crypto.randomUUID();
    await appendSupportMessage(conversation.id, "outbound", "Synthetic explanation.\n\nWhich option interests you?", { deliveryStatus: "queued", providerMessageId: id, createdAt: queuedAt });
    runSophieTurnMock.mockResolvedValue(okResult({ action: "no_reply", reply: null, nextQuestion: null }));
    await processInboundSupportMessage(personId, "OK sounds good", undefined, { createdAt: inboundAt });
    expect(runSophieTurnMock).not.toHaveBeenCalled();
    await recordSmsDeliveryReceipt(id, "sent", sentAt);
    await resumeSophieSms(personId);
    const preview = runSophieTurnMock.mock.calls[0][0];
    expect(preview.messages.map((m: { body: string }) => m.body)).toEqual(["OK sounds good", "Synthetic explanation.\n\nWhich option interests you?"]);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("applies STOP immediately while an outgoing text is queued", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    await appendSupportMessage(conversation.id, "outbound", "Synthetic pending response", { deliveryStatus: "queued" });
    await processInboundSupportMessage(personId, "STOP");
    expect(await isCustomerSmsDnd(personId)).toBe(true);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect((await listSupportMessages(conversation.id)).some((m) => m.body === "STOP")).toBe(true);
  });
});
