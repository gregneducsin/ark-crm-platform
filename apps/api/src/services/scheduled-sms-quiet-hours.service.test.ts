import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, conversationsTable, conversationMessagesTable, followUpJobsTable, intakeLinkTokensTable,
  questionnaireEventsTable, abandonedCartTriggersTable, leadCheckinTriggersTable,
  objectionReengagementTriggersTable, reviewRequestTriggersTable, unmatchedSmsThreadsTable, unmatchedSmsMessagesTable } from "@luma/db";
import { sweepScheduledSalesSms, type ScheduledSalesSmsKind } from "./scheduled-sales-sms.service.js";
import { sweepReviewRequestTriggers } from "./order-fulfillment.service.js";
import { recordAndClassifyUnmatchedSms } from "./unmatched-inbound-sms.service.js";
import { recordSmsDeliveryReceipt } from "./sms-delivery.service.js";
import { SmsQuietHoursError } from "../lib/send-window.js";

const mocks = vi.hoisted(() => ({ send: vi.fn(), classify: vi.fn() }));
vi.mock("../lib/sms-provider.js", () => ({ getSmsProvider: () => ({ sendMessage: mocks.send }) }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: mocks.classify }; } }));
vi.mock("../lib/slack.js", () => ({ notifySlack: vi.fn(), notifySmsSlack: vi.fn() }));

const tables = { follow_up: followUpJobsTable, abandoned_cart: abandonedCartTriggersTable,
  lead_checkin: leadCheckinTriggersTable, objection_reengagement: objectionReengagementTriggersTable };
const kinds = Object.keys(tables) as ScheduledSalesSmsKind[];
const night = new Date("2026-01-15T06:00:00Z"); // 1am Eastern
const morning = new Date("2026-01-15T14:00:00Z");
let sequence = 0;
async function customer() {
  const [row] = await db.insert(customersTable).values({ firstName: "Synthetic", lastName: "QuietHours", email: `${crypto.randomUUID()}@example.com`, phone: `+1555666${String(++sequence).padStart(4, "0")}`, leadReceivedDate: "2026-01-15" }).returning();
  return row;
}
async function seed(kind: ScheduledSalesSmsKind) {
  const person = await customer();
  const dueAt = new Date(night.getTime() - 60_000);
  let id: string;
  if (kind === "follow_up") {
    const [token] = await db.insert(intakeLinkTokensTable).values({ personId: person.id, tokenHash: crypto.randomUUID(), expiresAt: morning, clickedAt: night }).returning();
    const [job] = await db.insert(followUpJobsTable).values({ personId: person.id, intakeLinkTokenId: token.id, dueAt }).returning(); id = job.id;
  } else if (kind === "abandoned_cart") {
    const [event] = await db.insert(questionnaireEventsTable).values({ personId: person.id, questionnaireId: crypto.randomUUID(), status: "abandoned", lastEventAt: night }).returning();
    const [job] = await db.insert(abandonedCartTriggersTable).values({ personId: person.id, questionnaireEventId: event.id, dueAt }).returning(); id = job.id;
  } else {
    const [job] = await db.insert(tables[kind]).values({ personId: person.id, dueAt }).returning(); id = job.id;
  }
  return { person, id };
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(night);
  for (const table of [...Object.values(tables), reviewRequestTriggersTable, unmatchedSmsThreadsTable]) await db.delete(table);
  mocks.send.mockReset().mockImplementation(async () => {
    const providerMessageId = crypto.randomUUID();
    await recordSmsDeliveryReceipt(providerMessageId, "sent", new Date());
    return { providerMessageId };
  });
  mocks.classify.mockReset().mockResolvedValue({ content: [{ type: "tool_use", name: "classify_unmatched_sms", input: {
    intent: "new_lead_interest", summary: "Synthetic inquiry", suggestedReply: null, senderName: null, senderEmail: null,
    matchCandidateIndex: null, matchConfidence: null, needsHumanReview: false, confirmsExistingCustomer: false, productCategoryMentioned: "none",
  } }] });
  process.env.ANTHROPIC_API_KEY = "test-only";
});
afterEach(() => vi.useRealTimers());

describe("scheduled SMS quiet hours", () => {
  it.each(kinds)("%s waits until opening without consuming an attempt, then sends once", async (kind) => {
    const { id } = await seed(kind);
    await sweepScheduledSalesSms(kind);
    const [held] = await db.select().from(tables[kind]).where(eq(tables[kind].id, id));
    expect(held.status).toBe("pending"); expect(held.dueAt).toEqual(morning);
    if ("attemptCount" in held) expect(held.attemptCount).toBe(0);
    expect(mocks.send).not.toHaveBeenCalled();
    vi.setSystemTime(morning);
    await sweepScheduledSalesSms(kind); await sweepScheduledSalesSms(kind);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect((await db.select().from(tables[kind]).where(eq(tables[kind].id, id)))[0].status).toBe("sent");
  });

  it("releases an unsent reservation without failure or retry consumption if closing time is reached at transport", async () => {
    vi.setSystemTime(new Date("2026-01-15T23:59:59Z"));
    const { id } = await seed("lead_checkin");
    mocks.send.mockImplementationOnce(async () => { vi.setSystemTime(new Date("2026-01-16T01:00:00Z")); throw new SmsQuietHoursError(); });
    await sweepScheduledSalesSms("lead_checkin");
    const [job] = await db.select().from(leadCheckinTriggersTable).where(eq(leadCheckinTriggersTable.id, id));
    expect(job.status).toBe("pending"); expect(job.attemptCount).toBe(0); expect(job.failureReason).toBeNull();
    expect(job.dueAt).toEqual(new Date("2026-01-16T14:00:00Z"));
    expect(await db.select().from(conversationMessagesTable).where(eq(conversationMessagesTable.id, id))).toHaveLength(0);
  });

  it("recovers an already-confirmed scheduled send overnight without resending", async () => {
    const { id, person } = await seed("lead_checkin");
    const [thread] = await db.insert(conversationsTable).values({ personId: person.id }).returning();
    await db.update(leadCheckinTriggersTable).set({ status: "processing" }).where(eq(leadCheckinTriggersTable.id, id));
    await db.insert(conversationMessagesTable).values({ id, conversationId: thread.id, direction: "outbound", body: "Synthetic sent message", deliveryStatus: "sent", sentAt: night });
    await sweepScheduledSalesSms("lead_checkin");
    expect((await db.select().from(leadCheckinTriggersTable).where(eq(leadCheckinTriggersTable.id, id)))[0].status).toBe("sent");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("holds review requests overnight and sends at opening", async () => {
    const person = await customer();
    await db.insert(reviewRequestTriggersTable).values({ personId: person.id, dueAt: night });
    await sweepReviewRequestTriggers(); expect(mocks.send).not.toHaveBeenCalled();
    const [held] = await db.select().from(reviewRequestTriggersTable).where(eq(reviewRequestTriggersTable.personId, person.id));
    expect(held.status).toBe("pending"); expect(held.attemptCount).toBe(0);
    vi.setSystemTime(morning); await sweepReviewRequestTriggers();
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("returns a review request to pending when transport preparation crosses closing time", async () => {
    vi.setSystemTime(morning);
    const person = await customer();
    await db.insert(reviewRequestTriggersTable).values({ personId: person.id, dueAt: night });
    mocks.send.mockImplementationOnce(async () => { vi.setSystemTime(new Date("2026-01-16T01:00:00Z")); throw new SmsQuietHoursError(); });
    expect(await sweepReviewRequestTriggers()).toEqual({ sentCount: 0, failedCount: 0, cancelledCount: 0 });
    const [job] = await db.select().from(reviewRequestTriggersTable).where(eq(reviewRequestTriggersTable.personId, person.id));
    expect(job.status).toBe("pending"); expect(job.attemptCount).toBe(0);
    expect(job.dueAt).toEqual(new Date("2026-01-16T14:00:00Z"));
    vi.setSystemTime(job.dueAt); await sweepReviewRequestTriggers();
    expect((await db.select().from(reviewRequestTriggersTable).where(eq(reviewRequestTriggersTable.id, job.id)))[0].status).toBe("sent");
  });
});
