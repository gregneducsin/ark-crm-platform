import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, conversationsTable, conversationMessagesTable } from "@luma/db";
import { recordSmsInbound, getSmsReplyWork, finishSmsReplyWork, hasPendingSmsDelivery, sendTrackedSms, recordSmsDeliveryReceipt, sweepSmsDeliveryTimeouts } from "./sms-delivery.service.js";
import { recordPhoneSmsOptOut } from "../lib/sms-opt-out.js";
const send = vi.hoisted(() => vi.fn());
vi.mock("../lib/sms-provider.js", () => ({ getSmsProvider: () => ({ sendMessage: send }) }));

async function fixture() {
  const [person] = await db.insert(customersTable).values({ firstName: "Synthetic", lastName: "Timing", email: `timing-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-09-22", phone: "+15551234567" }).returning();
  const [conversation] = await db.insert(conversationsTable).values({ personId: person.id }).returning();
  await recordSmsInbound(person.id, "sales", conversation.id, "First synthetic message");
  const work = await getSmsReplyWork(person.id, "sales");
  return { personId: person.id, conversationId: conversation.id, generation: work!.generation };
}

describe("durable SMS delivery", () => {
  it("records a blocked draft as unsent rather than an uncertain transport failure", async () => {
    const f = await fixture();
    const phone = "+15558889876";
    await recordPhoneSmsOptOut(phone);
    send.mockClear();
    await sendTrackedSms(f.personId, "sales", f.conversationId, phone, "Synthetic blocked draft", f.generation);
    expect(send).not.toHaveBeenCalled();
    const rows = await db.select().from(conversationMessagesTable).where(eq(conversationMessagesTable.conversationId, f.conversationId));
    expect(rows.find((m) => m.direction === "outbound")?.deliveryStatus).toBe("failed");
    expect(await getSmsReplyWork(f.personId, "sales")).toBeUndefined();
  });
  it("preserves provider receipt time and message ID for inbound messages", async () => {
    const f = await fixture();
    const createdAt = new Date("2026-09-22T12:00:00Z");
    const row = await recordSmsInbound(f.personId, "sales", f.conversationId, "More context", undefined, { providerMessageId: "synthetic-inbound", createdAt });
    expect(row.createdAt).toEqual(createdAt);
    expect(row.providerMessageId).toBe("synthetic-inbound");
    await finishSmsReplyWork(f.personId, "sales", f.generation);
    expect(await getSmsReplyWork(f.personId, "sales")).toBeDefined();
  });

  it("retains newer work while awaiting confirmation and handles early, duplicate and reordered receipts", async () => {
    const f = await fixture();
    const id = crypto.randomUUID();
    const sentAt = new Date("2026-09-22T12:01:00Z");
    const deliveredAt = new Date("2026-09-22T12:02:00Z");
    send.mockImplementationOnce(async () => {
      await recordSmsInbound(f.personId, "sales", f.conversationId, "Second synthetic message");
      expect(await hasPendingSmsDelivery(f.personId)).toBe(true);
      await recordSmsDeliveryReceipt(id, "delivered", deliveredAt);
      return { providerMessageId: id };
    });
    await sendTrackedSms(f.personId, "sales", f.conversationId, "+15551234567", "One combined response", f.generation);
    await recordSmsDeliveryReceipt(id, "sent", sentAt);
    await recordSmsDeliveryReceipt(id, "failed", new Date());
    await recordSmsDeliveryReceipt(id, "delivered", deliveredAt);
    const [message] = await db.select().from(conversationMessagesTable).where(eq(conversationMessagesTable.providerMessageId, id));
    expect(message.deliveryStatus).toBe("delivered");
    expect(message.sentAt).toEqual(sentAt);
    expect(message.deliveredAt).toEqual(deliveredAt);
    expect(await hasPendingSmsDelivery(f.personId)).toBe(false);
    expect(await getSmsReplyWork(f.personId, "sales")).toBeDefined();
  });

  it("flags missing receipts even without another inbound, retaining a hold after a late receipt", async () => {
    const f = await fixture();
    const id = crypto.randomUUID();
    send.mockResolvedValueOnce({ providerMessageId: id });
    await sendTrackedSms(f.personId, "sales", f.conversationId, "+15551234567", "Synthetic response", f.generation);
    await db.update(conversationMessagesTable).set({ createdAt: new Date(Date.now() - 6 * 60_000) }).where(eq(conversationMessagesTable.providerMessageId, id));
    await sweepSmsDeliveryTimeouts();
    const [conversation] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, f.conversationId));
    expect(conversation.needsAttention).toBe(true);
    expect((await getSmsReplyWork(f.personId, "sales"))?.heldForStaff).toBe(true);
    await recordSmsDeliveryReceipt(id, "sent", new Date());
    expect((await getSmsReplyWork(f.personId, "sales"))?.heldForStaff).toBe(true);
  });

  it("never retries a send whose transport outcome is unknown", async () => {
    const f = await fixture();
    send.mockReset().mockRejectedValueOnce(new Error("connection lost after submission"));
    await sendTrackedSms(f.personId, "sales", f.conversationId, "+15551234567", "Synthetic response", f.generation);
    await sendTrackedSms(f.personId, "sales", f.conversationId, "+15551234567", "Synthetic response", f.generation);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await getSmsReplyWork(f.personId, "sales"))?.heldForStaff).toBe(true);
    const rows = await db.select().from(conversationMessagesTable).where(eq(conversationMessagesTable.conversationId, f.conversationId));
    expect(rows.find((m) => m.direction === "outbound")?.deliveryStatus).toBe("unknown");
  });
});

it("does not send or clear a staff hold raised while a turn was running", async () => {
  const f = await fixture();
  const id = crypto.randomUUID();
  await db.insert(conversationMessagesTable).values({ conversationId: f.conversationId, direction: "outbound", body: "Earlier synthetic message", providerMessageId: id, deliveryStatus: "sent" });
  await recordSmsDeliveryReceipt(id, "failed", new Date());
  send.mockReset();
  await sendTrackedSms(f.personId, "sales", f.conversationId, "+15551234567", "Obsolete draft", f.generation);
  await finishSmsReplyWork(f.personId, "sales", f.generation);
  expect(send).not.toHaveBeenCalled();
  expect((await getSmsReplyWork(f.personId, "sales"))?.heldForStaff).toBe(true);
});
