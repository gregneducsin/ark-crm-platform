import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db, customersTable, conversationsTable, conversationMessagesTable, supportConversationsTable,
  supportConversationMessagesTable, emailConversationsTable, supportEmailConversationsTable, smsReplyWorkTable,
  followUpJobsTable, intakeLinkTokensTable, questionnaireEventsTable, purchasesTable,
  abandonedCartTriggersTable, leadCheckinTriggersTable, objectionReengagementTriggersTable,
} from "@luma/db";
import { withPersonLock } from "../lib/db-lock.js";
import { clampToSendWindow } from "../lib/send-window.js";
import { recordSmsInbound, recordSmsDeliveryReceipt, sweepSmsDeliveryTimeouts } from "./sms-delivery.service.js";
import { sweepScheduledSalesSms, type ScheduledSalesSmsKind } from "./scheduled-sales-sms.service.js";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../lib/sms-provider.js", () => ({ getSmsProvider: () => ({ sendMessage: mocks.send }) }));
const tables = {
  follow_up: followUpJobsTable, abandoned_cart: abandonedCartTriggersTable,
  lead_checkin: leadCheckinTriggersTable, objection_reengagement: objectionReengagementTriggersTable,
};
const kinds = Object.keys(tables) as ScheduledSalesSmsKind[];
const people: string[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function seed(kind: ScheduledSalesSmsKind = "lead_checkin") {
  const [person] = await db.insert(customersTable).values({ firstName: "Synthetic", lastName: "Scheduled",
    email: `${crypto.randomUUID()}@example.com`, phone: "+15550001000", leadReceivedDate: "2026-09-23" }).returning();
  people.push(person.id);
  const dueAt = new Date(Date.now() - 60_000);
  let id: string;
  if (kind === "follow_up") {
    const [token] = await db.insert(intakeLinkTokensTable).values({ personId: person.id, tokenHash: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000), clickedAt: new Date(Date.now() - 3 * 3_600_000) }).returning();
    const [job] = await db.insert(followUpJobsTable).values({ personId: person.id, intakeLinkTokenId: token.id, dueAt }).returning();
    id = job.id;
  } else if (kind === "abandoned_cart") {
    const [event] = await db.insert(questionnaireEventsTable).values({ personId: person.id, questionnaireId: crypto.randomUUID(),
      status: "abandoned", lastEventAt: new Date() }).returning();
    const [job] = await db.insert(abandonedCartTriggersTable).values({ personId: person.id, questionnaireEventId: event.id, dueAt }).returning();
    id = job.id;
  } else {
    const [job] = await db.insert(tables[kind]).values({ personId: person.id, dueAt }).returning();
    id = job.id;
  }
  return { personId: person.id, id, dueAt, kind };
}
async function jobFor(item: Awaited<ReturnType<typeof seed>>) {
  const table = tables[item.kind];
  const [job] = await db.select().from(table).where(eq(table.id, item.id));
  return job;
}
async function conversation(personId: string) {
  await db.insert(conversationsTable).values({ personId }).onConflictDoNothing();
  const [row] = await db.select().from(conversationsTable).where(eq(conversationsTable.personId, personId));
  return row;
}
async function confirmSend() {
  const providerMessageId = `synthetic-${crypto.randomUUID()}`;
  await recordSmsDeliveryReceipt(providerMessageId, "sent", new Date());
  return { providerMessageId };
}
beforeEach(async () => {
  // These sweep integration tests share the test schema with other suites.
  for (const table of Object.values(tables)) await db.delete(table);
  mocks.send.mockReset().mockImplementation(confirmSend);
});
afterEach(async () => {
  if (people.length) await db.delete(customersTable).where(inArray(customersTable.id, people.splice(0)));
});

describe("scheduled sales SMS send-time protections", () => {
  it.each(kinds)("%s preserves Ark's default sales pause and resumes without duplicate sends", async (kind) => {
    const item = await seed(kind);
    const original = process.env.SALES_SMS_ENABLED;
    try {
      delete process.env.SALES_SMS_ENABLED;
      await sweepScheduledSalesSms(kind);
      expect(mocks.send).not.toHaveBeenCalled();
      expect((await jobFor(item)).status).toBe("pending");
      process.env.SALES_SMS_ENABLED = "true";
      await sweepScheduledSalesSms(kind);
      await sweepScheduledSalesSms(kind);
      expect(mocks.send).toHaveBeenCalledTimes(1);
    } finally {
      if (original === undefined) delete process.env.SALES_SMS_ENABLED;
      else process.env.SALES_SMS_ENABLED = original;
    }
  });
  it.each(kinds)("%s defers a staff hold without changing its schedule, then sends once after release", async (kind) => {
    const item = await seed(kind);
    const thread = await conversation(item.personId);
    await db.update(conversationsTable).set({ needsAttention: true }).where(eq(conversationsTable.id, thread.id));
    await sweepScheduledSalesSms(kind);
    expect(mocks.send).not.toHaveBeenCalled();
    expect((await jobFor(item)).status).toBe("pending");
    expect((await jobFor(item)).dueAt).toEqual(item.dueAt);
    await db.update(conversationsTable).set({ needsAttention: false }).where(eq(conversationsTable.id, thread.id));
    await sweepScheduledSalesSms(kind);
    await sweepScheduledSalesSms(kind);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect((await jobFor(item)).status).toBe("sent");
  });

  it.each(["stop", "cancel", "purchase", "staff", "inbound", "reschedule"] as const)("rechecks %s committed while waiting for a live turn's lock", async (change) => {
    const item = await seed();
    const thread = await conversation(item.personId);
    const acquired = deferred(); const release = deferred();
    const holder = withPersonLock(item.personId, async () => { acquired.resolve(); await release.promise; });
    await acquired.promise;
    const sweeping = sweepScheduledSalesSms(item.kind);
    try {
      // Inspect the real advisory-lock waiter, not a timing guess.
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select 1 from pg_locks where locktype = 'advisory' and not granted and objid = (hashtext(${item.personId})::bigint & 4294967295)::oid`);
        expect(waiting.rows.length).toBeGreaterThan(0);
      });
      if (change === "stop") await db.update(customersTable).set({ dnd: true }).where(eq(customersTable.id, item.personId));
      if (change === "cancel") await db.update(leadCheckinTriggersTable).set({ status: "cancelled", cancelledReason: "staff_cancelled" }).where(eq(leadCheckinTriggersTable.id, item.id));
      if (change === "purchase") await db.insert(purchasesTable).values({ customerId: item.personId, purchaseDate: "2026-09-23", orderNumber: crypto.randomUUID(), productName: "Synthetic", amountPaid: "1.00", status: "completed" });
      if (change === "staff") await db.update(conversationsTable).set({ needsAttention: true }).where(eq(conversationsTable.id, thread.id));
      if (change === "inbound") await recordSmsInbound(item.personId, "sales", thread.id, "One more question");
      if (change === "reschedule") await db.update(leadCheckinTriggersTable).set({ dueAt: new Date(Date.now() + 86_400_000) }).where(eq(leadCheckinTriggersTable.id, item.id));
    } finally { release.resolve(); await holder; await sweeping; }
    expect(mocks.send).not.toHaveBeenCalled();
    expect((await jobFor(item)).status).toBe(["stop", "cancel", "purchase"].includes(change) ? "cancelled" : "pending");
    const [job] = await db.select().from(leadCheckinTriggersTable).where(eq(leadCheckinTriggersTable.id, item.id));
    expect(job.attemptCount).toBe(0);
  });

  it.each([supportConversationsTable, emailConversationsTable, supportEmailConversationsTable])("respects a staff hold on another channel", async (table) => {
    const item = await seed();
    await db.insert(table).values({ personId: item.personId, needsAttention: true });
    await sweepScheduledSalesSms(item.kind);
    expect(mocks.send).not.toHaveBeenCalled();
    expect((await jobFor(item)).status).toBe("pending");
  });

  it("waits for support delivery confirmation, and for durable inbound work to finish", async () => {
    const item = await seed();
    const [support] = await db.insert(supportConversationsTable).values({ personId: item.personId }).returning();
    const providerMessageId = crypto.randomUUID();
    await db.insert(supportConversationMessagesTable).values({ conversationId: support.id, direction: "outbound", body: "Synthetic staff response", deliveryStatus: "queued", providerMessageId });
    await sweepScheduledSalesSms(item.kind);
    expect(mocks.send).not.toHaveBeenCalled();
    await recordSmsInbound(item.personId, "support", support.id, "Thanks, another question");
    await recordSmsDeliveryReceipt(providerMessageId, "sent", new Date());
    await sweepScheduledSalesSms(item.kind);
    expect(mocks.send).not.toHaveBeenCalled();
    await db.delete(smsReplyWorkTable).where(eq(smsReplyWorkTable.personId, item.personId));
    await sweepScheduledSalesSms(item.kind);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("respects an explicit reply hold even when the visible attention flag is clear", async () => {
    const item = await seed();
    await db.insert(smsReplyWorkTable).values({ personId: item.personId, persona: "sales", heldForStaff: true });
    await sweepScheduledSalesSms(item.kind);
    expect(mocks.send).not.toHaveBeenCalled();
    expect((await jobFor(item)).status).toBe("pending");
  });

  it("paces different scheduled message types through the same pending sales delivery", async () => {
    const item = await seed("lead_checkin");
    await db.insert(objectionReengagementTriggersTable).values({ personId: item.personId, dueAt: item.dueAt });
    const providerMessageId = crypto.randomUUID();
    mocks.send.mockResolvedValue({ providerMessageId });
    await Promise.all([sweepScheduledSalesSms(item.kind), sweepScheduledSalesSms("objection_reengagement")]);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const [other] = await db.select().from(objectionReengagementTriggersTable).where(eq(objectionReengagementTriggersTable.personId, item.personId));
    expect([(await jobFor(item)).status, other.status].sort()).toEqual(["pending", "processing"]);
  });

  it("reserves before transport, awaits a receipt, and recovers the next step once without resending", async () => {
    const item = await seed("follow_up");
    const providerMessageId = crypto.randomUUID();
    mocks.send.mockImplementation(async () => {
      const [outbound] = await db.select().from(conversationMessagesTable).where(eq(conversationMessagesTable.id, item.id));
      expect(outbound.deliveryStatus).toBe("queued");
      expect((await jobFor(item)).status).toBe("processing");
      return { providerMessageId };
    });
    await Promise.all([sweepScheduledSalesSms(item.kind), sweepScheduledSalesSms(item.kind)]);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect((await jobFor(item)).status).toBe("processing");
    expect(await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.personId, item.personId))).toHaveLength(1);
    const actualSentAt = new Date();
    await recordSmsDeliveryReceipt(providerMessageId, "sent", actualSentAt);
    await sweepScheduledSalesSms(item.kind);
    await sweepScheduledSalesSms(item.kind);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect((await jobFor(item)).sentAt).toEqual(actualSentAt);
    const jobs = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.personId, item.personId));
    expect(jobs).toHaveLength(2);
    expect(jobs.find((job) => job.messageStep === "intake_questions_check_in")?.dueAt).toEqual(clampToSendWindow(new Date(actualSentAt.getTime() + 3_600_000)));
  });

  it("does not overwrite cancellation or arm another step when cancellation arrives during transport", async () => {
    const item = await seed("follow_up");
    const started = deferred(); const release = deferred();
    mocks.send.mockImplementation(async () => { started.resolve(); await release.promise; return confirmSend(); });
    const sweeping = sweepScheduledSalesSms(item.kind);
    await started.promise;
    try { await db.update(followUpJobsTable).set({ status: "cancelled", cancelledReason: "staff_cancelled" }).where(eq(followUpJobsTable.id, item.id)); }
    finally { release.resolve(); await sweeping; }
    expect((await jobFor(item)).status).toBe("cancelled");
    expect(await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.personId, item.personId))).toHaveLength(1);
    await sweepScheduledSalesSms(item.kind);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it.each(["exception", "no_receipt", "failed_receipt", "legacy_processing"] as const)("holds %s for staff and never blindly retries", async (failure) => {
    const item = await seed();
    if (failure !== "legacy_processing") await conversation(item.personId);
    if (failure === "legacy_processing") await db.update(leadCheckinTriggersTable).set({ status: "processing" }).where(eq(leadCheckinTriggersTable.id, item.id));
    const providerMessageId = crypto.randomUUID();
    mocks.send.mockImplementation(async () => {
      if (failure === "exception") throw new Error("Connection lost after possible acceptance");
      if (failure === "failed_receipt") await recordSmsDeliveryReceipt(providerMessageId, "failed", new Date());
      return { providerMessageId };
    });
    await sweepScheduledSalesSms(item.kind);
    if (failure === "no_receipt") {
      await db.update(conversationMessagesTable).set({ createdAt: new Date(Date.now() - 6 * 60_000) }).where(eq(conversationMessagesTable.id, item.id));
      await sweepSmsDeliveryTimeouts();
      await sweepScheduledSalesSms(item.kind);
    }
    await db.update(leadCheckinTriggersTable).set({ updatedAt: new Date(Date.now() - 3_600_000) }).where(eq(leadCheckinTriggersTable.id, item.id));
    await sweepScheduledSalesSms(item.kind);
    expect(mocks.send).toHaveBeenCalledTimes(failure === "legacy_processing" ? 0 : 1);
    expect((await jobFor(item)).status).toBe("failed");
    expect((await jobFor(item)).failureReason).toBe("SMS_DELIVERY_UNCONFIRMED_REVIEW_REQUIRED");
    expect((await conversation(item.personId)).needsAttention).toBe(true);
    const [work] = await db.select().from(smsReplyWorkTable).where(eq(smsReplyWorkTable.personId, item.personId));
    expect(work.heldForStaff).toBe(true);
  });

  it("does not arm a follow-up child if STOP arrived while waiting for the receipt", async () => {
    const item = await seed("follow_up");
    const providerMessageId = crypto.randomUUID();
    mocks.send.mockResolvedValue({ providerMessageId });
    await sweepScheduledSalesSms(item.kind);
    await db.update(customersTable).set({ dnd: true }).where(eq(customersTable.id, item.personId));
    await recordSmsDeliveryReceipt(providerMessageId, "delivered", new Date());
    await sweepScheduledSalesSms(item.kind);
    expect((await jobFor(item)).status).toBe("sent");
    expect(await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.personId, item.personId))).toHaveLength(1);
  });
});

// Business-flow fixtures run during allowed hours; quiet-hours boundaries
// and overnight deferral are exercised in scheduled-sms-quiet-hours.service.test.ts.
vi.mock("../lib/send-window.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/send-window.js")>();
  return { ...actual, isScheduledSmsTime: () => true, assertScheduledSmsTime: () => {} };
});
