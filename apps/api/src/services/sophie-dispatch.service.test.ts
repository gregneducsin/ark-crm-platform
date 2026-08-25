import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, supportConversationsTable } from "@luma/db";
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

const { processInboundSupportMessage } = await import("./sophie-dispatch.service.js");
const { getOrCreateSupportConversation, listSupportMessages } = await import("./support-conversations.service.js");

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

describe("processInboundSupportMessage", () => {
  it("persists the inbound message, tags its sentiment, and sends+logs both reply and nextQuestion", async () => {
    runSophieTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_1" }).mockResolvedValueOnce({ providerMessageId: "msg_2" });
    runSophieTurnMock.mockResolvedValueOnce(okResult({ inboundSentiment: "positive" }));

    const personId = await seedCustomer();
    const result = await processInboundSupportMessage(personId, "Has my order shipped?");

    expect(result.ok).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock).toHaveBeenNthCalledWith(1, "+15551230001", "Your order shipped this morning.");
    expect(sendMessageMock).toHaveBeenNthCalledWith(2, "+15551230001", "Anything else I can help with?");

    const conversation = await getOrCreateSupportConversation(personId);
    const messages = await listSupportMessages(conversation.id);
    expect(messages.map((m) => ({ direction: m.direction, body: m.body }))).toEqual([
      { direction: "inbound", body: "Has my order shipped?" },
      { direction: "outbound", body: "Your order shipped this morning." },
      { direction: "outbound", body: "Anything else I can help with?" },
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

  it("serializes two double-texted inbound messages instead of racing them", async () => {
    runSophieTurnMock.mockClear();
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue({ providerMessageId: "msg_race" });

    const seenHistoryLengths: number[] = [];
    runSophieTurnMock.mockImplementation(async (body: { messages: readonly unknown[] }) => {
      seenHistoryLengths.push(body.messages.length);
      const isFirstCall = seenHistoryLengths.length === 1;
      if (isFirstCall) {
        // Force real overlap: the second processInboundSupportMessage call
        // starts while this first one is still mid-turn.
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      return okResult({ reply: isFirstCall ? "First reply." : "Second reply.", nextQuestion: null });
    });

    const personId = await seedCustomer();
    const [r1, r2] = await Promise.all([
      processInboundSupportMessage(personId, "first text"),
      processInboundSupportMessage(personId, "second text"),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Without serialization, the second call's Claude turn would start
    // immediately and only see its own inbound message (history length 1).
    // With the lock, it only starts once the first call has fully persisted
    // its inbound message and outbound reply, so it sees both plus its own.
    expect(seenHistoryLengths).toEqual([1, 3]);

    const conversation = await getOrCreateSupportConversation(personId);
    const messages = await listSupportMessages(conversation.id);
    expect(messages.map((m) => ({ direction: m.direction, body: m.body }))).toEqual([
      { direction: "inbound", body: "first text" },
      { direction: "outbound", body: "First reply." },
      { direction: "inbound", body: "second text" },
      { direction: "outbound", body: "Second reply." },
    ]);
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
});
