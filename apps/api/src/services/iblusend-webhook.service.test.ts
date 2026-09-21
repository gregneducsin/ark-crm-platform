import { describe, expect, it, vi } from "vitest";
import {
  db,
  customersTable,
  conversationsTable,
  conversationMessagesTable,
  supportConversationsTable,
  supportConversationMessagesTable,
  unmatchedSmsThreadsTable,
  unmatchedSmsMessagesTable,
  webhookEventsTable,
} from "@luma/db";
import { eq } from "drizzle-orm";

const processInboundMessageMock = vi.fn().mockResolvedValue({ ok: true });
vi.mock("./alexis-dispatch.service.js", () => ({ processInboundMessage: processInboundMessageMock }));

const processInboundSupportMessageMock = vi.fn().mockResolvedValue({ ok: true });
vi.mock("./sophie-dispatch.service.js", () => ({ processInboundSupportMessage: processInboundSupportMessageMock }));

const recordAndClassifyUnmatchedSmsMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./unmatched-inbound-sms.service.js", () => ({ recordAndClassifyUnmatchedSms: recordAndClassifyUnmatchedSmsMock }));

const notifySmsSlackMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/slack.js", () => ({ notifySmsSlack: (...args: unknown[]) => notifySmsSlackMock(...args) }));

const { handleIbluSendWebhook } = await import("./iblusend-webhook.service.js");

// A fresh, collision-free phone number per call — the suite has other test
// files seeding customers with hardcoded phone numbers, and a shared
// (non-schema-isolated) DATABASE_URL across files means a hardcoded number
// here could match an unrelated customer from another file's test, causing
// findCustomerIdByPhone to silently resolve to the wrong row. Digits only
// (not the raw hex UUID, which can contain a-f) — findCustomerIdByPhone
// matches on digits, so a letter in the "phone number" would break the
// same-number-should-match assertions below.
function uniquePhone(): string {
  const digits = crypto.randomUUID().replace(/\D/g, "");
  return `+1555${(digits + "0000000").slice(0, 7)}`;
}

async function seedCustomer(phone: string): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "iBluSend",
      lastName: "Test",
      email: `iblusend-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-17",
      phone,
    })
    .returning({ id: customersTable.id });
  return row.id;
}

function envelope(overrides: { event?: string; eventId?: string; data?: Record<string, unknown> } = {}) {
  return {
    event: overrides.event ?? "message.received",
    event_id: overrides.eventId ?? crypto.randomUUID(),
    timestamp: "2026-08-17T12:00:00.000Z",
    api_version: "2026-03-07",
    data: {
      message_id: crypto.randomUUID(),
      phone_number: uniquePhone(),
      content: "hello",
      direction: "incoming",
      service_type: "iMessage",
      ...overrides.data,
    },
  };
}

describe("handleIbluSendWebhook", () => {
  it("routes to Sophie when a support conversation already exists for the customer", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();

    const phone = uniquePhone();
    const personId = await seedCustomer(phone);
    await db.insert(supportConversationsTable).values({ personId });

    const result = await handleIbluSendWebhook(envelope({ data: { phone_number: phone, content: "when should I take this" } }));

    expect(result).toEqual({ duplicate: false });
    expect(processInboundSupportMessageMock).toHaveBeenCalledWith(personId, "when should I take this");
    expect(processInboundMessageMock).not.toHaveBeenCalled();
  });

  it("routes to Alexis when only a Alexis conversation exists, no support conversation", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();

    const phone = uniquePhone();
    const personId = await seedCustomer(phone);
    await db.insert(conversationsTable).values({ personId });

    const result = await handleIbluSendWebhook(envelope({ data: { phone_number: phone, content: "how much is it" } }));

    expect(result).toEqual({ duplicate: false });
    expect(processInboundMessageMock).toHaveBeenCalledWith(personId, "how much is it");
    expect(processInboundSupportMessageMock).not.toHaveBeenCalled();
  });

  it("prefers Sophie over Alexis when both conversations exist", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();

    const phone = uniquePhone();
    const personId = await seedCustomer(phone);
    await db.insert(conversationsTable).values({ personId });
    await db.insert(supportConversationsTable).values({ personId });

    await handleIbluSendWebhook(envelope({ data: { phone_number: phone } }));

    expect(processInboundSupportMessageMock).toHaveBeenCalled();
    expect(processInboundMessageMock).not.toHaveBeenCalled();
  });

  it("matches a customer whose phone is stored without a country code or plus sign", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();

    const bareDigits = uniquePhone().replace(/\D/g, "").slice(-10);
    const personId = await seedCustomer(bareDigits);
    await db.insert(conversationsTable).values({ personId });

    const result = await handleIbluSendWebhook(envelope({ data: { phone_number: `+1${bareDigits}`, content: "hi" } }));

    expect(result).toEqual({ duplicate: false });
    expect(processInboundMessageMock).toHaveBeenCalledWith(personId, "hi");
  });

  it("routes to the purchased customer's Sophie conversation, not a stale unsold lead sharing the same phone", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();

    const phone = uniquePhone();
    // The stale lead: signed up first, never purchased, only ever talked to Alexis.
    const staleLeadId = await seedCustomer(phone);
    await db.insert(conversationsTable).values({ personId: staleLeadId });
    // The real customer: same phone, purchased later, has a Sophie support conversation.
    const purchasedCustomerId = await seedCustomer(phone);
    await db.insert(supportConversationsTable).values({ personId: purchasedCustomerId });

    const result = await handleIbluSendWebhook(envelope({ data: { phone_number: phone, content: "thank you" } }));

    expect(result).toEqual({ duplicate: false });
    expect(processInboundSupportMessageMock).toHaveBeenCalledWith(purchasedCustomerId, "thank you");
    expect(processInboundMessageMock).not.toHaveBeenCalled();
  });

  it("routes an unrecognized phone number to the unmatched-SMS pipeline instead of either bot", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();
    recordAndClassifyUnmatchedSmsMock.mockClear();

    const phone = uniquePhone();
    const result = await handleIbluSendWebhook(envelope({ data: { phone_number: phone, content: "hi there" } }));

    expect(result).toEqual({ duplicate: false });
    expect(processInboundMessageMock).not.toHaveBeenCalled();
    expect(processInboundSupportMessageMock).not.toHaveBeenCalled();
    expect(recordAndClassifyUnmatchedSmsMock).toHaveBeenCalledWith(phone, "hi there");
  });

  it("still marks the webhook event processed even when the unmatched-SMS pipeline itself throws", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();
    recordAndClassifyUnmatchedSmsMock.mockClear();
    recordAndClassifyUnmatchedSmsMock.mockRejectedValueOnce(new Error("boom"));

    const result = await handleIbluSendWebhook(envelope({ data: { phone_number: uniquePhone(), content: "hi" } }));

    expect(result).toEqual({ duplicate: false });
  });

  it("routes to Alexis for a known customer's first-ever text, with no prior Alexis or Sophie conversation", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();

    const phone = uniquePhone();
    const personId = await seedCustomer(phone);
    await handleIbluSendWebhook(envelope({ data: { phone_number: phone, content: "hey is this ark health" } }));

    expect(processInboundMessageMock).toHaveBeenCalledWith(personId, "hey is this ark health");
    expect(processInboundSupportMessageMock).not.toHaveBeenCalled();
  });

  it("still processes a picture-only text with no caption, using a placeholder body and passing the media URL through, instead of silently dropping it", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();

    const phone = uniquePhone();
    const personId = await seedCustomer(phone);
    await handleIbluSendWebhook(envelope({ data: { phone_number: phone, content: null, media_urls: ["https://cdn.iblusend.example/media/abc123.jpg"] } }));

    expect(processInboundMessageMock).toHaveBeenCalledWith(personId, "[Image attached]", undefined, ["https://cdn.iblusend.example/media/abc123.jpg"]);
  });

  it("passes both the caption and the media URLs through when a message has both", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();

    const phone = uniquePhone();
    const personId = await seedCustomer(phone);
    await handleIbluSendWebhook(
      envelope({ data: { phone_number: phone, content: "here's a pic of the rash", media_urls: ["https://cdn.iblusend.example/media/def456.jpg"] } }),
    );

    expect(processInboundMessageMock).toHaveBeenCalledWith(personId, "here's a pic of the rash", undefined, ["https://cdn.iblusend.example/media/def456.jpg"]);
  });

  it("still drops a message with neither content nor media_urls (nothing meaningful to process)", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();
    recordAndClassifyUnmatchedSmsMock.mockClear();

    const phone = uniquePhone();
    await seedCustomer(phone);
    await handleIbluSendWebhook(envelope({ data: { phone_number: phone, content: null, media_urls: null } }));

    expect(processInboundMessageMock).not.toHaveBeenCalled();
    expect(recordAndClassifyUnmatchedSmsMock).not.toHaveBeenCalled();
  });

  it("ignores outbound-direction messages", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();

    const phone = uniquePhone();
    const personId = await seedCustomer(phone);
    await db.insert(conversationsTable).values({ personId });

    await handleIbluSendWebhook(envelope({ data: { phone_number: phone, direction: "outgoing" } }));

    expect(processInboundMessageMock).not.toHaveBeenCalled();
  });

  it("acknowledges and no-ops for an event type it doesn't act on", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();

    const result = await handleIbluSendWebhook(envelope({ event: "message.delivered", data: { status: "delivered" } }));

    expect(result).toEqual({ duplicate: false });
    expect(processInboundMessageMock).not.toHaveBeenCalled();
    expect(processInboundSupportMessageMock).not.toHaveBeenCalled();
  });

  it("dedupes on event_id — a second delivery of the same occurrence is reported as duplicate and not re-dispatched", async () => {
    processInboundMessageMock.mockClear();
    processInboundSupportMessageMock.mockClear();

    const phone = uniquePhone();
    const personId = await seedCustomer(phone);
    await db.insert(conversationsTable).values({ personId });

    const eventId = crypto.randomUUID();
    const first = await handleIbluSendWebhook(envelope({ eventId, data: { phone_number: phone } }));
    const second = await handleIbluSendWebhook(envelope({ eventId, data: { phone_number: phone } }));

    expect(first).toEqual({ duplicate: false });
    expect(second).toEqual({ duplicate: true });
    expect(processInboundMessageMock).toHaveBeenCalledTimes(1);
  });

  it("records the webhook event with source iblusend_message", async () => {
    const eventId = crypto.randomUUID();
    await handleIbluSendWebhook(envelope({ eventId, data: { phone_number: uniquePhone() } }));

    const [row] = await db.select().from(webhookEventsTable).where(eq(webhookEventsTable.externalEventId, eventId));
    expect(row?.source).toBe("iblusend_message");
    expect(row?.status).toBe("processed");
  });

  describe("message.failed", () => {
    it("retroactively flags an Alexis conversation message as failed and alerts Slack", async () => {
      notifySmsSlackMock.mockClear();

      const phone = uniquePhone();
      const personId = await seedCustomer(phone);
      const [conversation] = await db.insert(conversationsTable).values({ personId }).returning({ id: conversationsTable.id });
      const messageId = crypto.randomUUID();
      const [message] = await db
        .insert(conversationMessagesTable)
        .values({ conversationId: conversation.id, direction: "outbound", body: "hi", providerMessageId: messageId, deliveryStatus: "sent" })
        .returning({ id: conversationMessagesTable.id });

      const result = await handleIbluSendWebhook(envelope({ event: "message.failed", data: { message_id: messageId } }));

      expect(result).toEqual({ duplicate: false });
      const [updated] = await db.select().from(conversationMessagesTable).where(eq(conversationMessagesTable.id, message.id));
      expect(updated.deliveryStatus).toBe("failed");
      expect(notifySmsSlackMock).toHaveBeenCalledWith(expect.stringContaining(messageId));
    });

    it("retroactively flags a Sophie support conversation message as failed", async () => {
      const phone = uniquePhone();
      const personId = await seedCustomer(phone);
      const [supportConversation] = await db.insert(supportConversationsTable).values({ personId }).returning({ id: supportConversationsTable.id });
      const messageId = crypto.randomUUID();
      const [message] = await db
        .insert(supportConversationMessagesTable)
        .values({ conversationId: supportConversation.id, direction: "outbound", body: "hi", providerMessageId: messageId, deliveryStatus: "sent" })
        .returning({ id: supportConversationMessagesTable.id });

      await handleIbluSendWebhook(envelope({ event: "message.failed", data: { message_id: messageId } }));

      const [updated] = await db.select().from(supportConversationMessagesTable).where(eq(supportConversationMessagesTable.id, message.id));
      expect(updated.deliveryStatus).toBe("failed");
    });

    it("retroactively flags an unmatched-SMS message as failed", async () => {
      const phone = uniquePhone();
      const [thread] = await db.insert(unmatchedSmsThreadsTable).values({ fromPhone: phone }).returning({ id: unmatchedSmsThreadsTable.id });
      const messageId = crypto.randomUUID();
      const [message] = await db
        .insert(unmatchedSmsMessagesTable)
        .values({ threadId: thread.id, direction: "outbound", body: "what's your email?", providerMessageId: messageId })
        .returning({ id: unmatchedSmsMessagesTable.id });

      await handleIbluSendWebhook(envelope({ event: "message.failed", data: { message_id: messageId } }));

      const [updated] = await db.select().from(unmatchedSmsMessagesTable).where(eq(unmatchedSmsMessagesTable.id, message.id));
      expect(updated.deliveryStatus).toBe("failed");
    });

    it("logs a warning and doesn't throw when no outbound message matches the given message_id", async () => {
      notifySmsSlackMock.mockClear();

      const result = await handleIbluSendWebhook(envelope({ event: "message.failed", data: { message_id: crypto.randomUUID() } }));

      expect(result).toEqual({ duplicate: false });
      expect(notifySmsSlackMock).not.toHaveBeenCalled();
    });
  });
});
