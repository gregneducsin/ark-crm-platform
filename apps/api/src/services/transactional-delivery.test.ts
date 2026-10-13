import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, supportConversationsTable, supportConversationMessagesTable, smsReplyWorkTable } from "@luma/db";
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../lib/sms-provider.js", () => ({ getSmsProvider: () => ({ sendMessage: mocks.send }) }));
vi.mock("../lib/email/send-trigger-email.js", () => ({ sendTriggerEmail: vi.fn() }));
vi.mock("../lib/slack.js", () => ({ notifySlack: vi.fn(), notifySmsSlack: vi.fn() }));
import { sendOrderReceivedOpener, sendRefillOrderReceivedNotice, handlePrescriptionWritten, handlePaymentFailed } from "./order-fulfillment.service.js";
import { recordSmsDeliveryReceipt, sweepSmsDeliveryTimeouts } from "./sms-delivery.service.js";
import { setCustomerSmsDnd } from "./dnd.service.js";

beforeEach(() => mocks.send.mockReset());
async function seed(phone: string | null = "+15550001234") {
  const [person] = await db.insert(customersTable).values({ firstName: "Synthetic", lastName: "Delivery", email: `${crypto.randomUUID()}@example.com`, phone, leadReceivedDate: "2026-10-12" }).returning();
  return person.id;
}
async function state(personId: string) {
  const [conversation] = await db.select().from(supportConversationsTable).where(eq(supportConversationsTable.personId, personId));
  const messages = await db.select().from(supportConversationMessagesTable).where(eq(supportConversationMessagesTable.conversationId, conversation.id));
  return { conversation, messages };
}
const notices = [
  ["order", sendOrderReceivedOpener], ["refill", sendRefillOrderReceivedNotice], ["prescription", handlePrescriptionWritten],
  ["first payment failure", (id: string) => handlePaymentFailed(id, true)],
  ["recurring payment failure", (id: string) => handlePaymentFailed(id, false)],
] as const;
describe.each(notices)("tracked %s notice", (_name, send) => {
  it("reserves before transport, then uses provider timestamps rather than acceptance time", async () => {
    const id = await seed(); const providerId = crypto.randomUUID();
    mocks.send.mockImplementationOnce(async () => {
      expect((await state(id)).messages[0]).toMatchObject({ deliveryStatus: "queued", sentAt: null });
      return { providerMessageId: providerId };
    });
    await send(id);
    expect((await state(id)).messages[0]).toMatchObject({ deliveryStatus: "queued", providerMessageId: providerId, sentAt: null });
    const sentAt = new Date("2026-10-12T12:00:00Z");
    await recordSmsDeliveryReceipt(providerId, "sent", sentAt);
    expect((await state(id)).messages[0]).toMatchObject({ deliveryStatus: "sent", sentAt });
    await recordSmsDeliveryReceipt(providerId, "delivered", new Date(sentAt.getTime() + 1000));
    expect((await state(id)).messages[0].deliveryStatus).toBe("delivered");
  });
  it("reconciles a failure receipt arriving before the provider response and preserves its review reason", async () => {
    const id = await seed(); const providerId = crypto.randomUUID();
    mocks.send.mockImplementationOnce(async () => {
      const { conversation } = await state(id);
      await db.update(supportConversationsTable).set({ needsAttention: true, needsAttentionReason: "Clinical review is required." }).where(eq(supportConversationsTable.id, conversation.id));
      await recordSmsDeliveryReceipt(providerId, "failed", new Date());
      return { providerMessageId: providerId };
    });
    await send(id);
    const { conversation, messages } = await state(id);
    expect(messages[0].deliveryStatus).toBe("failed");
    expect(conversation.needsAttentionReason).toContain("Clinical review is required.");
    expect(conversation.needsAttentionReason).toContain("SMS delivery");
    expect(conversation.needsAttention).toBe(true);
  });
  it("holds uncertain transport without claiming definite failure or retrying", async () => {
    const id = await seed(); mocks.send.mockRejectedValueOnce(new Error("Disconnected after possible acceptance"));
    await send(id); await sweepSmsDeliveryTimeouts();
    const { conversation, messages } = await state(id);
    expect(messages).toHaveLength(1); expect(messages[0].deliveryStatus).toBe("unknown");
    expect(conversation.needsAttentionReason).toContain("SMS delivery");
    const holds = await db.select().from(smsReplyWorkTable).where(eq(smsReplyWorkTable.personId, id));
    expect(holds.some(h => h.heldForStaff)).toBe(true); expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("flags missing confirmations through the timeout sweep", async () => {
    const id = await seed(); mocks.send.mockResolvedValueOnce({ providerMessageId: null });
    await send(id); const { messages } = await state(id);
    await db.update(supportConversationMessagesTable).set({ createdAt: new Date(Date.now()-6*60_000) }).where(eq(supportConversationMessagesTable.id, messages[0].id));
    await sweepSmsDeliveryTimeouts();
    expect((await state(id)).messages[0].deliveryStatus).toBe("unknown");
    expect((await state(id)).conversation.needsAttentionReason).toContain("SMS delivery");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("records a missing phone as failed and visible to staff", async () => {
    const id = await seed(null); await send(id);
    expect(mocks.send).not.toHaveBeenCalled();
    expect((await state(id)).messages[0].deliveryStatus).toBe("failed");
    expect((await state(id)).conversation.needsAttentionReason).toContain("SMS delivery");
  });
  it("does not send or create a delivery incident for an opted-out customer", async () => {
    const id = await seed(null); await setCustomerSmsDnd(id, true); await send(id);
    expect(mocks.send).not.toHaveBeenCalled(); expect((await state(id)).messages).toHaveLength(0);
    expect((await state(id)).conversation.needsAttentionReason ?? "").not.toContain("SMS delivery");
  });
});
