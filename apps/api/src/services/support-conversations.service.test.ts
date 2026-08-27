import { describe, expect, it, vi } from "vitest";
import { db, customersTable } from "@luma/db";

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
});

const notifySlackMock = vi.fn();
vi.mock("../lib/slack.js", () => ({ notifySlack: (...args: unknown[]) => notifySlackMock(...args) }));

const {
  getOrCreateSupportConversation,
  appendSupportMessage,
  setSupportMessageSentiment,
  listSupportMessages,
  updateSupportConversationState,
  toSophiePreviewBody,
  listSupportConversationSummaries,
  getSupportConversationDetail,
  sendStaffReply,
} = await import("./support-conversations.service.js");

async function seedCustomer(opts: { phone?: string | null } = {}): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "Support",
      lastName: "Test",
      email: `support-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-16",
      phone: opts.phone === undefined ? "+15557770001" : opts.phone,
    })
    .returning({ id: customersTable.id });
  return row.id;
}

describe("getOrCreateSupportConversation", () => {
  it("creates a conversation with default state on first call", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    expect(conversation.personId).toBe(personId);
    expect(conversation.status).toBe("active");
    expect(conversation.prescriptionWritten).toBe(false);
    expect(conversation.orderShipped).toBe(false);
    expect(conversation.trackingNumber).toBeNull();
    expect(conversation.reviewRequested).toBe(false);
  });

  it("returns the same conversation on subsequent calls (1:1 per customer)", async () => {
    const personId = await seedCustomer();
    const first = await getOrCreateSupportConversation(personId);
    const second = await getOrCreateSupportConversation(personId);
    expect(second.id).toBe(first.id);
  });
});

describe("appendSupportMessage / listSupportMessages", () => {
  it("appends messages in order and returns them oldest-first", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    await appendSupportMessage(conversation.id, "outbound", "Hello, this is Sophie.");
    await appendSupportMessage(conversation.id, "inbound", "Has my order shipped?");

    const messages = await listSupportMessages(conversation.id);
    expect(messages.map((m) => m.body)).toEqual(["Hello, this is Sophie.", "Has my order shipped?"]);
    expect(messages.map((m) => m.direction)).toEqual(["outbound", "inbound"]);
  });
});

describe("setSupportMessageSentiment", () => {
  it("updates an existing message's sentiment", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    const msg = await appendSupportMessage(conversation.id, "inbound", "This has been great!");
    await setSupportMessageSentiment(msg.id, "positive");

    const messages = await listSupportMessages(conversation.id);
    expect(messages[0].sentiment).toBe("positive");
  });

  it("is a no-op when sentiment is null", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    const msg = await appendSupportMessage(conversation.id, "inbound", "hmm", { sentiment: "neutral" });
    await setSupportMessageSentiment(msg.id, null);

    const messages = await listSupportMessages(conversation.id);
    expect(messages[0].sentiment).toBe("neutral");
  });
});

describe("updateSupportConversationState", () => {
  it("only patches the given fields, leaving the rest untouched", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    await updateSupportConversationState(conversation.id, { prescriptionWritten: true, trackingNumber: "TRACK123" });

    const updated = await getOrCreateSupportConversation(personId);
    expect(updated.prescriptionWritten).toBe(true);
    expect(updated.trackingNumber).toBe("TRACK123");
    expect(updated.orderShipped).toBe(false);
  });
});

describe("toSophiePreviewBody", () => {
  it("maps conversation order state and history into the shape runSophieTurn expects", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    await updateSupportConversationState(conversation.id, {
      prescriptionWritten: true,
      orderShipped: true,
      trackingNumber: "TRACK999",
      reviewRequested: true,
      lastQuestion: "Anything else?",
    });
    const updated = await getOrCreateSupportConversation(personId);
    const messages = await appendSupportMessage(conversation.id, "inbound", "thanks!").then(() => listSupportMessages(conversation.id));

    const body = toSophiePreviewBody(updated, messages);
    expect(body.orderState).toEqual({ prescriptionWritten: true, orderShipped: true, trackingNumber: "TRACK999", paymentFailed: false });
    expect(body.reviewRequested).toBe(true);
    expect(body.lastQuestion).toBe("Anything else?");
    expect(body.messages).toEqual([{ direction: "inbound", body: "thanks!" }]);
  });
});

describe("listSupportConversationSummaries / getSupportConversationDetail", () => {
  it("includes the customer's name, last message preview, and last inbound sentiment", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);
    await appendSupportMessage(conversation.id, "outbound", "Hello");
    await appendSupportMessage(conversation.id, "inbound", "All good, thanks!", { sentiment: "positive" });

    const summaries = await listSupportConversationSummaries();
    const summary = summaries.find((s) => s.personId === personId);
    expect(summary).toBeDefined();
    expect(summary?.firstName).toBe("Support");
    expect(summary?.lastMessagePreview).toBe("All good, thanks!");
    expect(summary?.lastSentiment).toBe("positive");

    const detail = await getSupportConversationDetail(conversation.id);
    expect(detail?.messages.length).toBe(2);
  });

  it("getSupportConversationDetail returns null for an unknown conversation id", async () => {
    const detail = await getSupportConversationDetail("00000000-0000-0000-0000-000000000000");
    expect(detail).toBeNull();
  });

  it("sorts a conversation with real messages ahead of one with none, not behind it", async () => {
    const emptyPersonId = await seedCustomer();
    await getOrCreateSupportConversation(emptyPersonId);

    const activePersonId = await seedCustomer();
    const activeConversation = await getOrCreateSupportConversation(activePersonId);
    await appendSupportMessage(activeConversation.id, "outbound", "Hello");

    const summaries = await listSupportConversationSummaries();
    const activeIndex = summaries.findIndex((s) => s.personId === activePersonId);
    const emptyIndex = summaries.findIndex((s) => s.personId === emptyPersonId);
    expect(activeIndex).toBeGreaterThanOrEqual(0);
    expect(emptyIndex).toBeGreaterThanOrEqual(0);
    // A bare "ORDER BY ... DESC" sorts NULLs first in Postgres, which would
    // put the zero-message conversation ahead of the active one — the
    // opposite of "most recently active first".
    expect(activeIndex).toBeLessThan(emptyIndex);
  });
});

describe("sendStaffReply", () => {
  it("sends through the SMS provider, logs the outbound message, and clears needsAttention", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_staff_support_1" });

    const personId = await seedCustomer({ phone: "+15557770010" });
    const conversation = await getOrCreateSupportConversation(personId);
    await updateSupportConversationState(conversation.id, { needsAttention: true });

    const result = await sendStaffReply(conversation.id, "The label has your exact dosing instructions.", "staff@example.com");

    expect(result).toEqual({ sent: true });
    expect(sendMessageMock).toHaveBeenCalledWith("+15557770010", "The label has your exact dosing instructions.");

    const messages = await listSupportMessages(conversation.id);
    expect(messages[0]).toMatchObject({
      direction: "outbound",
      body: "The label has your exact dosing instructions.",
      providerMessageId: "msg_staff_support_1",
      sentBy: "staff",
      sentByStaffEmail: "staff@example.com",
    });

    const updated = await getSupportConversationDetail(conversation.id);
    expect(updated?.conversation.needsAttention).toBe(false);
  });

  it("returns not_found for an unknown conversation id, without touching the provider", async () => {
    sendMessageMock.mockClear();
    const result = await sendStaffReply("00000000-0000-0000-0000-000000000000", "hi", "staff@example.com");
    expect(result).toEqual({ sent: false, reason: "not_found" });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("returns no_phone and sends nothing when the customer has no phone on file", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer({ phone: null });
    const conversation = await getOrCreateSupportConversation(personId);

    const result = await sendStaffReply(conversation.id, "hi", "staff@example.com");

    expect(result).toEqual({ sent: false, reason: "no_phone" });
    expect(sendMessageMock).not.toHaveBeenCalled();
    const messages = await listSupportMessages(conversation.id);
    expect(messages).toHaveLength(0);
  });

  it("still logs the message and leaves needsAttention set when the provider send fails", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockRejectedValueOnce(new Error("iBluSend send failed: 429"));

    const personId = await seedCustomer({ phone: "+15557770011" });
    const conversation = await getOrCreateSupportConversation(personId);
    await updateSupportConversationState(conversation.id, { needsAttention: true });

    const result = await sendStaffReply(conversation.id, "trying to reply", "staff@example.com");

    expect(result).toEqual({ sent: false, reason: "send_failed" });
    const messages = await listSupportMessages(conversation.id);
    expect(messages[0]).toMatchObject({ direction: "outbound", body: "trying to reply", providerMessageId: null });

    const updated = await getSupportConversationDetail(conversation.id);
    expect(updated?.conversation.needsAttention).toBe(true);
  });
});

describe("updateSupportConversationState — Slack alert on needsAttention", () => {
  it("alerts Slack the first time a conversation is flagged, naming the customer and reason", async () => {
    notifySlackMock.mockClear();
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);

    await updateSupportConversationState(conversation.id, { needsAttention: true, needsAttentionReason: "payment failed" });

    expect(notifySlackMock).toHaveBeenCalledTimes(1);
    expect(notifySlackMock.mock.calls[0][0]).toContain("payment failed");
  });

  it("does not re-alert on a subsequent patch while already flagged", async () => {
    notifySlackMock.mockClear();
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);

    await updateSupportConversationState(conversation.id, { needsAttention: true, needsAttentionReason: "first reason" });
    await updateSupportConversationState(conversation.id, { needsAttention: true, needsAttentionReason: "still flagged" });

    expect(notifySlackMock).toHaveBeenCalledTimes(1);
  });

  it("does not alert when the patch doesn't touch needsAttention", async () => {
    notifySlackMock.mockClear();
    const personId = await seedCustomer();
    const conversation = await getOrCreateSupportConversation(personId);

    await updateSupportConversationState(conversation.id, { lastQuestion: "anything else?" });

    expect(notifySlackMock).not.toHaveBeenCalled();
  });
});
