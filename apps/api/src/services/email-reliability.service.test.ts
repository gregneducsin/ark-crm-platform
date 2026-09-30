import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, customersTable, conversationsTable, supportConversationsTable, purchasesTable,
  emailConversationsTable, supportEmailConversationsTable, emailConversationMessagesTable, supportEmailConversationMessagesTable } from "@luma/db";

const mocks = vi.hoisted(() => ({ alexis: vi.fn(), sophie: vi.fn(), send: vi.fn() }));
vi.mock("./alexis-conversation.service.js", () => ({ runAlexisTurn: mocks.alexis }));
vi.mock("./sophie-conversation.service.js", () => ({ runSophieTurn: mocks.sophie }));
vi.mock("../lib/email-provider.js", () => ({ getEmailProvider: () => ({ provider: { sendEmail: mocks.send }, fromName: "Synthetic Support" }) }));
vi.mock("../lib/slack.js", () => ({ notifySlack: vi.fn(), notifySmsSlack: vi.fn() }));
import { dispatchInboundEmail } from "./email-inbound.service.js";
import { getUnifiedConversationDetail } from "./unified-conversations.service.js";
import { sweepEmailDeliveryTimeouts } from "./email-delivery.service.js";
import { sendEmailStaffReply as sendSalesStaffReply } from "./alexis-email-dispatch.service.js";
import { sendEmailStaffReply as sendSupportStaffReply } from "./sophie-email-dispatch.service.js";

const people: string[] = [];
const originalEnv = { ...process.env };
const result = { ok: true, action: "reply", reply: "Synthetic reply", nextQuestion: "Can we help further?", link: null,
  objectionStage: 0, objectionKey: null, linkProvided: false, promoOffered: false, inboundSentiment: "neutral",
  requiresStaff: false, knowledgeTopicsUsed: [], validatedSlotUpdates: {}, source: "model", preCheckCode: null,
  learnedFirstName: null, preferredReengagementDate: null };
beforeEach(() => {
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "synthetic-test-secret";
  process.env.INTAKE_LINK_BASE_URL = "https://example.com";
  mocks.alexis.mockReset().mockResolvedValue(result); mocks.sophie.mockReset().mockResolvedValue(result);
  mocks.send.mockReset().mockImplementation(async () => ({ messageId: `<${crypto.randomUUID()}@example.com>` }));
});
afterEach(async () => {
  process.env = { ...originalEnv };
  if (people.length) await db.delete(customersTable).where(inArray(customersTable.id, people.splice(0)));
});
async function person(support = false) {
  const [row] = await db.insert(customersTable).values({ firstName: "Synthetic", lastName: "Email",
    email: `${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-09-23" }).returning();
  people.push(row.id);
  if (support) await db.insert(purchasesTable).values({ customerId: row.id, purchaseDate: "2026-09-23", orderNumber: crypto.randomUUID(), productName: "Synthetic", amountPaid: "1.00", status: "completed" });
  return row.id;
}
async function incoming(personId: string, messageId: string | null = `<${crypto.randomUUID()}@example.com>`, body = "A synthetic question", identity?: string) {
  await dispatchInboundEmail(personId, "Synthetic subject", body, messageId, "inbox@example.com", identity);
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

describe("durable email handling", () => {
  it("routes an SMS-only lead's first email to the dashboard and retains the sales source and receiving mailbox", async () => {
    const id = await person();
    await db.insert(conversationsTable).values({ personId: id, leadSource: "meta_form" });
    await incoming(id);
    const [thread] = await db.select().from(emailConversationsTable).where(eq(emailConversationsTable.personId, id));
    expect(thread.leadSource).toBe("meta_form");
    expect(thread.receivingAddress).toBe("inbox@example.com");
    expect(mocks.alexis).toHaveBeenCalledTimes(1); expect(mocks.sophie).not.toHaveBeenCalled();
    expect((await getUnifiedConversationDetail(id))?.messages).toMatchObject([
      { channel: "email", direction: "inbound", body: "A synthetic question" },
      { channel: "email", direction: "outbound", deliveryStatus: "sent" },
    ]);
    expect(mocks.send.mock.calls[0][3].fromEmailOverride).toBe("inbox@example.com");
  });

  it("routes a purchaser's first email to support even without any prior conversation", async () => {
    const id = await person(true); await incoming(id);
    expect(mocks.sophie).toHaveBeenCalledTimes(1); expect(mocks.alexis).not.toHaveBeenCalled();
    expect((await getUnifiedConversationDetail(id))?.messages[0]).toMatchObject({ persona: "support", channel: "email", direction: "inbound" });
  });

  it("initializes the first support email thread with the known fulfillment state", async () => {
    const id = await person();
    await db.insert(supportConversationsTable).values({ personId: id, prescriptionWritten: true, orderShipped: true, trackingNumber: "SYNTHETIC-TRACKING", paymentFailed: true });
    await incoming(id);
    const [thread] = await db.select().from(supportEmailConversationsTable).where(eq(supportEmailConversationsTable.personId, id));
    expect(thread).toMatchObject({ prescriptionWritten: true, orderShipped: true, trackingNumber: "SYNTHETIC-TRACKING", paymentFailed: true });
    expect(mocks.sophie).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("surfaces failed delivery, deduplicates retry, and holds new input for staff (support=%s)", async (support) => {
    const id = await person(support); const identity = `<${crypto.randomUUID()}@example.com>`;
    mocks.send.mockRejectedValueOnce(new Error("Transport disconnected after possible acceptance"));
    await incoming(id, identity); await incoming(id, identity); await incoming(id);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(support ? mocks.sophie : mocks.alexis).toHaveBeenCalledTimes(1);
    const detail = await getUnifiedConversationDetail(id);
    expect(detail?.messages).toHaveLength(3);
    expect(detail?.messages.find((m) => m.direction === "outbound")?.deliveryStatus).toBe("unknown");
    const table = support ? supportEmailConversationsTable : emailConversationsTable;
    const [thread] = await db.select().from(table).where(eq(table.personId, id));
    expect(thread.needsAttention).toBe(true);
    expect(thread.needsAttentionReason).toContain("unconfirmed");
    const staffReply = support ? sendSupportStaffReply : sendSalesStaffReply;
    expect(await staffReply(thread.id, "Staff reviewed the delivery and is helping.", "staff@example.com")).toEqual({ sent: true });
    const [cleared] = await db.select().from(table).where(eq(table.id, thread.id));
    expect(cleared.needsAttention).toBe(false);
    await incoming(id);
    expect(mocks.send).toHaveBeenCalledTimes(3);
  });

  it("records a definite preparation failure separately from uncertain transport", async () => {
    const id = await person(); delete process.env.INTAKE_LINK_BASE_URL;
    await incoming(id);
    expect(mocks.send).not.toHaveBeenCalled();
    expect((await getUnifiedConversationDetail(id))?.messages.find((m) => m.direction === "outbound")?.deliveryStatus).toBe("failed");
  });

  it("records the outgoing draft before attempting delivery and processes concurrent duplicates once", async () => {
    const id = await person(); const messageId = `<${crypto.randomUUID()}@example.com>`;
    mocks.send.mockImplementation(async () => {
      const detail = await getUnifiedConversationDetail(id);
      expect(detail?.messages.find((m) => m.direction === "outbound")?.deliveryStatus).toBe("queued");
      return { messageId: `<${crypto.randomUUID()}@example.com>` };
    });
    await Promise.all([incoming(id, messageId), incoming(id, messageId)]);
    expect(mocks.send).toHaveBeenCalledTimes(1); expect(mocks.alexis).toHaveBeenCalledTimes(1);
    expect((await getUnifiedConversationDetail(id))?.messages).toHaveLength(2);
  });

  it("deduplicates messages without RFC Message-ID using their separate inbound identity", async () => {
    const id = await person();
    await incoming(id, null, "First synthetic email", "mailbox-a:validity1:uid1");
    await incoming(id, null, "First synthetic email", "mailbox-a:validity1:uid1");
    await incoming(id, null, "Second synthetic email", "mailbox-b:validity1:uid1");
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls[0][3].inReplyTo).toBeUndefined();
    expect((await getUnifiedConversationDetail(id))?.messages).toHaveLength(4);
  });

  it("keeps a replay in its original thread after support routing becomes available", async () => {
    const id = await person(); const identity = `<${crypto.randomUUID()}@example.com>`;
    await incoming(id, identity);
    await db.insert(supportEmailConversationsTable).values({ personId: id });
    await incoming(id, identity);
    expect(mocks.send).toHaveBeenCalledTimes(1); expect(mocks.sophie).not.toHaveBeenCalled();
  });

  it("puts an interrupted saved inbound turn on staff review rather than rerunning it", async () => {
    const id = await person(); const identity = `<${crypto.randomUUID()}@example.com>`;
    const [thread] = await db.insert(emailConversationsTable).values({ personId: id }).returning();
    await db.insert(emailConversationMessagesTable).values({ conversationId: thread.id, direction: "inbound", subject: "Synthetic", body: "Saved before restart", messageId: identity, inboundEventId: identity });
    await incoming(id, identity);
    expect(mocks.alexis).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
    const [updated] = await db.select().from(emailConversationsTable).where(eq(emailConversationsTable.id, thread.id));
    expect(updated.needsAttention).toBe(true); expect(updated.needsAttentionReason).toContain("interrupted");
    expect((await getUnifiedConversationDetail(id))?.messages).toHaveLength(1);
  });

  it.each([false, true])("flags a stale outgoing reservation after restart without resending (support=%s)", async (support) => {
    const id = await person(support);
    const conversations = support ? supportEmailConversationsTable : emailConversationsTable;
    const messages = support ? supportEmailConversationMessagesTable : emailConversationMessagesTable;
    const [thread] = await db.insert(conversations).values({ personId: id }).returning();
    await db.insert(messages).values({ conversationId: thread.id, direction: "outbound", subject: "Synthetic", body: "Reserved before restart", deliveryStatus: "queued", createdAt: new Date(Date.now() - 6 * 60_000) });
    await sweepEmailDeliveryTimeouts(); await sweepEmailDeliveryTimeouts();
    expect(mocks.send).not.toHaveBeenCalled();
    const [message] = await db.select().from(messages).where(eq(messages.conversationId, thread.id));
    expect(message.deliveryStatus).toBe("unknown");
    const [updated] = await db.select().from(conversations).where(eq(conversations.id, thread.id));
    expect(updated.needsAttention).toBe(true);
  });

  it("saves a blocked reply and flags staff if another send is reserved while the model runs", async () => {
    const id = await person(); const started = deferred(); const release = deferred();
    mocks.alexis.mockImplementationOnce(async () => { started.resolve(); await release.promise; return result; });
    const processing = incoming(id); await started.promise;
    const [thread] = await db.select().from(emailConversationsTable).where(eq(emailConversationsTable.personId, id));
    try { await db.insert(emailConversationMessagesTable).values({ conversationId: thread.id, direction: "outbound", subject: "Synthetic", body: "A concurrent notification", deliveryStatus: "queued" }); }
    finally { release.resolve(); await processing; }
    expect(mocks.send).not.toHaveBeenCalled();
    const detail = await getUnifiedConversationDetail(id);
    expect(detail?.messages.filter((m) => m.direction === "outbound").map((m) => m.deliveryStatus)).toEqual(["queued", "failed"]);
    const [updated] = await db.select().from(emailConversationsTable).where(eq(emailConversationsTable.id, thread.id));
    expect(updated.needsAttention).toBe(true);
  });

  it("honors unsubscribe while a failed email is held for staff", async () => {
    const id = await person(); mocks.send.mockRejectedValueOnce(new Error("Synthetic transport failure"));
    await incoming(id); await incoming(id, null, "please unsubscribe me", crypto.randomUUID());
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, id));
    expect(customer.emailDnd).toBe(true); expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});
