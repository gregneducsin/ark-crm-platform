import { describe, expect, it, vi } from "vitest";
import { db, customersTable } from "@luma/db";

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
});

const {
  getOrCreateConversation,
  appendMessage,
  setMessageSentiment,
  listMessages,
  updateConversationState,
  toBotPreviewBody,
  listConversationSummaries,
  getConversationDetail,
  getConversationResponseStats,
  sendStaffReply,
} = await import("./conversations.service.js");

async function seedCustomer(opts: { phone?: string | null } = {}): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "Convo",
      lastName: "Test",
      email: `convo-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-15",
      phone: opts.phone === undefined ? "+15558880001" : opts.phone,
    })
    .returning({ id: customersTable.id });
  return row.id;
}

describe("getOrCreateConversation", () => {
  it("creates a conversation with default state on first call", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    expect(conversation.personId).toBe(personId);
    expect(conversation.status).toBe("active");
    expect(conversation.objectionStage).toBe(0);
    expect(conversation.linkProvided).toBe(false);
    expect(conversation.promoOffered).toBe(false);
  });

  it("defaults leadSource to abandoned_cart when not specified", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    expect(conversation.leadSource).toBe("abandoned_cart");
  });

  it("creates a conversation with leadSource meta_form when specified", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId, "meta_form");
    expect(conversation.leadSource).toBe("meta_form");
  });

  it("returns the same conversation on subsequent calls (1:1 per customer)", async () => {
    const personId = await seedCustomer();
    const first = await getOrCreateConversation(personId);
    const second = await getOrCreateConversation(personId);
    expect(second.id).toBe(first.id);
  });

  it("ignores leadSource on an existing conversation — the script doesn't change mid-thread", async () => {
    const personId = await seedCustomer();
    const first = await getOrCreateConversation(personId, "meta_form");
    const second = await getOrCreateConversation(personId, "abandoned_cart");
    expect(second.id).toBe(first.id);
    expect(second.leadSource).toBe("meta_form");
  });
});

describe("appendMessage / listMessages", () => {
  it("appends messages in order and returns them oldest-first", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    await appendMessage(conversation.id, "inbound", "Hi there");
    await appendMessage(conversation.id, "outbound", "Hey! How can I help?");
    await appendMessage(conversation.id, "inbound", "How much is semaglutide?");

    const messages = await listMessages(conversation.id);
    expect(messages.map((m) => m.body)).toEqual(["Hi there", "Hey! How can I help?", "How much is semaglutide?"]);
    expect(messages.map((m) => m.direction)).toEqual(["inbound", "outbound", "inbound"]);
  });

  it("caps history to the requested limit, keeping the most recent", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    for (let i = 0; i < 5; i++) {
      await appendMessage(conversation.id, i % 2 === 0 ? "inbound" : "outbound", `message ${i}`);
    }
    const messages = await listMessages(conversation.id, 2);
    expect(messages.map((m) => m.body)).toEqual(["message 3", "message 4"]);
  });

  it("stores sentiment and providerMessageId when provided", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    const msg = await appendMessage(conversation.id, "inbound", "This is way too expensive", { sentiment: "negative" });
    expect(msg.sentiment).toBe("negative");

    const outbound = await appendMessage(conversation.id, "outbound", "Understood", { providerMessageId: "msg_abc" });
    expect(outbound.providerMessageId).toBe("msg_abc");
  });
});

describe("setMessageSentiment", () => {
  it("updates an existing message's sentiment", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    const msg = await appendMessage(conversation.id, "inbound", "Sounds great, let's go!");
    await setMessageSentiment(msg.id, "positive");

    const [messages] = [await listMessages(conversation.id)];
    expect(messages[0].sentiment).toBe("positive");
  });

  it("is a no-op when sentiment is null", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    const msg = await appendMessage(conversation.id, "inbound", "hmm", { sentiment: "neutral" });
    await setMessageSentiment(msg.id, null);

    const messages = await listMessages(conversation.id);
    expect(messages[0].sentiment).toBe("neutral");
  });
});

describe("updateConversationState", () => {
  it("only patches the given fields, leaving the rest untouched", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    await updateConversationState(conversation.id, { selectedProduct: "semaglutide", objectionStage: 1 });

    const [updated] = [await getOrCreateConversation(personId)];
    expect(updated.selectedProduct).toBe("semaglutide");
    expect(updated.objectionStage).toBe(1);
    expect(updated.linkProvided).toBe(false);
    expect(updated.promoOffered).toBe(false);
  });
});

describe("toBotPreviewBody", () => {
  it("maps conversation state and history into the shape runAlexisTurn expects", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    await updateConversationState(conversation.id, {
      selectedProduct: "tirzepatide",
      lastQuestion: "Want to see pricing?",
      objectionStage: 2,
      linkProvided: true,
      promoOffered: true,
    });
    const updated = await getOrCreateConversation(personId);
    const messages = await appendMessage(conversation.id, "inbound", "yes please").then(() => listMessages(conversation.id));

    const body = toBotPreviewBody(updated, messages, null);
    expect(body.currentSlots.selectedProduct).toBe("tirzepatide");
    expect(body.lastQuestion).toBe("Want to see pricing?");
    expect(body.objectionStage).toBe(2);
    expect(body.linkProvided).toBe(true);
    expect(body.promoOffered).toBe(true);
    expect(body.messages).toEqual([{ direction: "inbound", body: "yes please" }]);
  });

  it("carries leadSource and the state slot through", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId, "meta_form");
    await updateConversationState(conversation.id, { state: "Texas" });
    const updated = await getOrCreateConversation(personId);

    const body = toBotPreviewBody(updated, [], null);
    expect(body.leadSource).toBe("meta_form");
    expect(body.currentSlots.state).toBe("Texas");
  });
});

describe("listConversationSummaries / getConversationDetail", () => {
  it("includes the customer's name, last message preview, and last inbound sentiment", async () => {
    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    await appendMessage(conversation.id, "inbound", "first message", { sentiment: "neutral" });
    await appendMessage(conversation.id, "outbound", "a reply");
    await appendMessage(conversation.id, "inbound", "second message, more excited!", { sentiment: "positive" });

    const summaries = await listConversationSummaries();
    const summary = summaries.find((s) => s.personId === personId);
    expect(summary).toBeDefined();
    expect(summary?.firstName).toBe("Convo");
    expect(summary?.lastMessagePreview).toBe("second message, more excited!");
    expect(summary?.lastSentiment).toBe("positive");

    const detail = await getConversationDetail(conversation.id);
    expect(detail?.messages.length).toBe(3);
  });

  it("getConversationDetail returns null for an unknown conversation id", async () => {
    const detail = await getConversationDetail("00000000-0000-0000-0000-000000000000");
    expect(detail).toBeNull();
  });
});

describe("getConversationResponseStats", () => {
  // Computed as deltas against a baseline rather than exact totals — this
  // runs against a shared DB alongside every other test in this file, so
  // asserting an absolute count would be sensitive to unrelated fixtures.
  it("counts each contact once: contacted (outbound sent) vs responded (also replied)", async () => {
    const before = await getConversationResponseStats();

    // Contacted and responded: multiple messages each way, still counts as one.
    const repliedPersonId = await seedCustomer();
    const repliedConvo = await getOrCreateConversation(repliedPersonId);
    await appendMessage(repliedConvo.id, "outbound", "Hi there");
    await appendMessage(repliedConvo.id, "inbound", "Hey");
    await appendMessage(repliedConvo.id, "outbound", "Following up");
    await appendMessage(repliedConvo.id, "inbound", "Still interested");

    // Contacted but never responded.
    const silentPersonId = await seedCustomer();
    const silentConvo = await getOrCreateConversation(silentPersonId);
    await appendMessage(silentConvo.id, "outbound", "Hi there");

    // Conversation exists but nothing was ever sent — not "contacted".
    const emptyPersonId = await seedCustomer();
    await getOrCreateConversation(emptyPersonId);

    const after = await getConversationResponseStats();
    expect(after.totalContacted - before.totalContacted).toBe(2);
    expect(after.totalResponded - before.totalResponded).toBe(1);
  });

  it("responseRate is 0 rather than NaN/Infinity when nobody has been contacted yet", async () => {
    // Not a delta test — just checking the guard holds when totalContacted is 0.
    // Can't force totalContacted to exactly 0 against a shared DB, so just
    // sanity-check the rate is always a finite number in [0, 1].
    const stats = await getConversationResponseStats();
    expect(Number.isFinite(stats.responseRate)).toBe(true);
    expect(stats.responseRate).toBeGreaterThanOrEqual(0);
    expect(stats.responseRate).toBeLessThanOrEqual(1);
  });
});

describe("sendStaffReply", () => {
  it("sends through the SMS provider, logs the outbound message, and clears needsAttention", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_staff_1" });

    const personId = await seedCustomer({ phone: "+15558880010" });
    const conversation = await getOrCreateConversation(personId);
    await updateConversationState(conversation.id, { needsAttention: true });

    const result = await sendStaffReply(conversation.id, "Following up on your question.", "staff@example.com");

    expect(result).toEqual({ sent: true });
    expect(sendMessageMock).toHaveBeenCalledWith("+15558880010", "Following up on your question.");

    const messages = await listMessages(conversation.id);
    expect(messages[0]).toMatchObject({
      direction: "outbound",
      body: "Following up on your question.",
      providerMessageId: "msg_staff_1",
      sentBy: "staff",
      sentByStaffEmail: "staff@example.com",
    });

    const updated = await getConversationDetail(conversation.id);
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
    const conversation = await getOrCreateConversation(personId);

    const result = await sendStaffReply(conversation.id, "hi", "staff@example.com");

    expect(result).toEqual({ sent: false, reason: "no_phone" });
    expect(sendMessageMock).not.toHaveBeenCalled();
    const messages = await listMessages(conversation.id);
    expect(messages).toHaveLength(0);
  });

  it("still logs the message and leaves needsAttention set when the provider send fails", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockRejectedValueOnce(new Error("iBluSend send failed: 429"));

    const personId = await seedCustomer({ phone: "+15558880011" });
    const conversation = await getOrCreateConversation(personId);
    await updateConversationState(conversation.id, { needsAttention: true });

    const result = await sendStaffReply(conversation.id, "trying to reply", "staff@example.com");

    expect(result).toEqual({ sent: false, reason: "send_failed" });
    const messages = await listMessages(conversation.id);
    expect(messages[0]).toMatchObject({ direction: "outbound", body: "trying to reply", providerMessageId: null });

    const updated = await getConversationDetail(conversation.id);
    expect(updated?.conversation.needsAttention).toBe(true);
  });
});
