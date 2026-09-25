import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, unmatchedSmsThreadsTable, unmatchedSmsMessagesTable, conversationsTable, conversationMessagesTable, smsReplyWorkTable } from "@luma/db";

const mocks = vi.hoisted(() => ({ classify: vi.fn(), send: vi.fn(), resume: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: mocks.classify }; } }));
vi.mock("../lib/sms-provider.js", () => ({ getSmsProvider: () => ({ sendMessage: mocks.send }) }));
vi.mock("./alexis-dispatch.service.js", () => ({ resumeAlexisSms: mocks.resume }));
vi.mock("../lib/slack.js", () => ({ notifySlack: vi.fn() }));
import { recordAndClassifyUnmatchedSms, resumeUnmatchedSms, sweepPendingUnmatchedSms, getUnmatchedSmsThreadDetail, sendUnmatchedInboundSmsReply } from "./unmatched-inbound-sms.service.js";
import { recordSmsDeliveryReceipt } from "./sms-delivery.service.js";
import { isPhoneSmsOptedOut } from "../lib/sms-opt-out.js";
import { isCustomerSmsDnd, isCustomerEmailDnd, setCustomerSmsDnd } from "./dnd.service.js";

describe("unknown sender SMS opt-out", () => {
  it.each(["STOP", "unsubscribe", "Please do not text me"])("saves %s before classification or a greeting", async (body) => {
    const number = phone();
    const thread = await recordAndClassifyUnmatchedSms(number, body);
    expect(await isPhoneSmsOptedOut(number)).toBe(true);
    expect(thread.onboardingHeld).toBe(true);
    expect(thread.pendingInboundId).toBeNull();
    expect(thread.suggestedReply).toBeNull();
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect((await getUnmatchedSmsThreadDetail(thread.id))?.messages.map((m) => m.body)).toEqual([body]);
  });

  it("preserves STOP across new input, staff reply, follow-up sweep, and account creation", async () => {
    const number = phone();
    const thread = await recordAndClassifyUnmatchedSms(number, "STOP");
    const formatted = `(${number.slice(2, 5)}) ${number.slice(5, 8)}-${number.slice(8)}`;
    await recordAndClassifyUnmatchedSms(formatted, "My name is Synthetic");
    expect((await getUnmatchedSmsThreadDetail(thread.id))?.messages).toHaveLength(2);
    expect(await sendUnmatchedInboundSmsReply(thread.id, "Hello")).toEqual({ sent: false, reason: "send_failed" });
    await db.update(unmatchedSmsThreadsTable).set({ updatedAt: new Date(Date.now() - 48 * 3600_000) }).where(eq(unmatchedSmsThreadsTable.id, thread.id));
    await sweepPendingUnmatchedSms();
    const [customer] = await db.insert(customersTable).values({ firstName: "Synthetic", lastName: "Optout", email: `${crypto.randomUUID()}@example.com`, phone: formatted, leadReceivedDate: "2026-09-23" }).returning();
    await setCustomerSmsDnd(customer.id, false);
    expect(await isCustomerSmsDnd(customer.id)).toBe(true);
    expect(await isCustomerEmailDnd(customer.id)).toBe(false);
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("invalidates an in-flight onboarding draft when STOP arrives", async () => {
    const number = phone();
    const started = deferred<void>();
    const draft = deferred<ReturnType<typeof result>>();
    mocks.classify.mockImplementationOnce(() => { started.resolve(); return draft.promise; });
    const first = recordAndClassifyUnmatchedSms(number, "Hello, I am interested");
    await started.promise;
    await recordAndClassifyUnmatchedSms(number, "STOP");
    draft.resolve(result({ senderName: "Synthetic Optout", senderEmail: `${crypto.randomUUID()}@example.com` }));
    await first;
    const thread = await threadFor(number);
    expect(thread.linkedCustomerId).toBeNull();
    expect(thread.onboardingHeld).toBe(true);
    expect(thread.suggestedReply).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function result(patch: Record<string, unknown> = {}) {
  return { content: [{ type: "tool_use", name: "classify_unmatched_sms", input: {
    intent: "new_lead_interest", summary: "Synthetic onboarding", suggestedReply: "What is your email?",
    senderName: "Synthetic", senderEmail: null, matchCandidateIndex: null, matchConfidence: null,
    needsHumanReview: false, confirmsExistingCustomer: false, productCategoryMentioned: "none", ...patch,
  } }] };
}
let nextPhone = 7000000;
function phone() { return `+1555${++nextPhone}`; }
async function threadFor(number: string) {
  const [thread] = await db.select().from(unmatchedSmsThreadsTable).where(eq(unmatchedSmsThreadsTable.fromPhone, number));
  return thread;
}
async function waitForInbound(number: string, count: number) {
  await vi.waitFor(async () => {
    const thread = await threadFor(number);
    expect(thread).toBeDefined();
    const detail = await getUnmatchedSmsThreadDetail(thread.id);
    expect(detail?.messages.filter((m) => m.direction === "inbound")).toHaveLength(count);
  });
}
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-only";
  mocks.classify.mockReset().mockResolvedValue(result());
  mocks.send.mockReset().mockImplementation(async () => ({ providerMessageId: `synthetic-${crypto.randomUUID()}` }));
  mocks.resume.mockReset().mockResolvedValue({ ok: true });
});

describe("durable onboarding message timing", () => {
  it("does not create another turn for a redelivered provider message", async () => {
    const number = phone();
    const metadata = { providerMessageId: `inbound-${crypto.randomUUID()}` };
    await recordAndClassifyUnmatchedSms(number, "My name is Synthetic", undefined, metadata);
    const repeated = await recordAndClassifyUnmatchedSms(number, "My name is Synthetic", undefined, metadata);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.classify).toHaveBeenCalledTimes(1);
    expect(repeated.pendingInboundId).toBeNull();
    expect((await getUnmatchedSmsThreadDetail(repeated.id))?.messages.filter((m) => m.direction === "inbound")).toHaveLength(1);
  });

  it("acknowledges durable handoff when immediate Alexis resumption fails", async () => {
    const number = phone();
    const unique = crypto.randomUUID();
    mocks.classify.mockResolvedValue(result({ senderName: `Synthetic ${unique}`, senderEmail: `${unique}@example.com` }));
    mocks.resume.mockRejectedValueOnce(new Error("temporary resume failure"));
    const thread = await recordAndClassifyUnmatchedSms(number, `Synthetic ${unique}, ${unique}@example.com`);
    expect(thread.linkedCustomerId).not.toBeNull();
    expect(await db.select().from(smsReplyWorkTable).where(eq(smsReplyWorkTable.personId, thread.linkedCustomerId!))).toHaveLength(1);
    const [conversation] = await db.select().from(conversationsTable).where(eq(conversationsTable.personId, thread.linkedCustomerId!));
    expect(await db.select().from(conversationMessagesTable).where(eq(conversationMessagesTable.conversationId, conversation.id))).toHaveLength(1);
  });

  it("discards a draft when another text arrives, even with an older provider timestamp", async () => {
    const number = phone();
    const started = deferred<void>();
    const draft = deferred<ReturnType<typeof result>>();
    mocks.classify.mockImplementationOnce(() => { started.resolve(); return draft.promise; });
    const first = recordAndClassifyUnmatchedSms(number, "Hi", undefined, { createdAt: new Date("2026-09-23T12:00:01Z") });
    await started.promise;
    const second = recordAndClassifyUnmatchedSms(number, "My name is Synthetic", undefined, { createdAt: new Date("2026-09-23T12:00:00Z") });
    try { await waitForInbound(number, 2); }
    finally { draft.resolve(result({ senderName: null, suggestedReply: "What is your name?" })); }
    await Promise.all([first, second]);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(number, "What is your email?");
    expect(mocks.classify.mock.calls[1][0].messages[0].content).toContain("My name is Synthetic");
    expect((await threadFor(number)).pendingInboundId).toBeNull();
  });

  it("creates one lead and transfers the whole burst once, then forwards a late unmatched request", async () => {
    const number = phone();
    const unique = crypto.randomUUID();
    const started = deferred<void>();
    const draft = deferred<ReturnType<typeof result>>();
    mocks.classify.mockImplementationOnce(() => { started.resolve(); return draft.promise; });
    mocks.classify.mockResolvedValue(result({ senderName: `Synthetic ${unique}`, senderEmail: `${unique}@example.com` }));
    const first = recordAndClassifyUnmatchedSms(number, "Hi, I want to get started");
    await started.promise;
    const second = recordAndClassifyUnmatchedSms(number, `My name is Synthetic ${unique}`);
    await waitForInbound(number, 2);
    const third = recordAndClassifyUnmatchedSms(number, `${unique}@example.com`, ["https://example.com/synthetic.jpg"]);
    try { await waitForInbound(number, 3); }
    finally { draft.resolve(result({ senderName: null })); }
    await Promise.all([first, second, third]);
    const thread = await threadFor(number);
    expect(thread.linkedCustomerId).not.toBeNull();
    expect(await db.select().from(customersTable).where(eq(customersTable.phone, number))).toHaveLength(1);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.resume).toHaveBeenCalledTimes(1);
    const [conversation] = await db.select().from(conversationsTable).where(eq(conversationsTable.personId, thread.linkedCustomerId!));
    const history = await db.select().from(conversationMessagesTable).where(eq(conversationMessagesTable.conversationId, conversation.id));
    expect(history).toHaveLength(3);
    expect(history.find((m) => m.body === `${unique}@example.com`)?.mediaUrls).toEqual(["https://example.com/synthetic.jpg"]);
    expect(await db.select().from(smsReplyWorkTable).where(eq(smsReplyWorkTable.personId, thread.linkedCustomerId!))).toHaveLength(1);
    // A request routed as unmatched just before the lead transaction commits
    // must transfer its message instead of rerunning onboarding.
    await recordAndClassifyUnmatchedSms(number, "One more detail");
    expect(mocks.classify).toHaveBeenCalledTimes(2);
    expect(await db.select().from(conversationMessagesTable).where(eq(conversationMessagesTable.conversationId, conversation.id))).toHaveLength(4);
    expect(mocks.resume).toHaveBeenCalledTimes(2);
  });

  it("retains and combines texts while a prior send is queued, then resumes on receipt", async () => {
    const number = phone();
    mocks.send.mockResolvedValueOnce({ providerMessageId: `queued-${number}` });
    const first = await recordAndClassifyUnmatchedSms(number, "My name is Synthetic");
    await recordAndClassifyUnmatchedSms(number, "A second detail");
    await recordAndClassifyUnmatchedSms(number, "A third detail");
    expect(mocks.classify).toHaveBeenCalledTimes(1);
    expect((await threadFor(number)).pendingInboundId).not.toBeNull();
    await recordSmsDeliveryReceipt(`queued-${number}`, "sent", new Date());
    await Promise.all([resumeUnmatchedSms(first.id), resumeUnmatchedSms(first.id)]);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.classify).toHaveBeenCalledTimes(2);
    const input = mocks.classify.mock.calls[1][0].messages[0].content;
    expect(input).toContain("A second detail");
    expect(input).toContain("A third detail");
  });

  it("recovers persisted work in the sweep without a live webhook handler", async () => {
    const number = phone();
    const [thread] = await db.insert(unmatchedSmsThreadsTable).values({ fromPhone: number }).returning();
    const [message] = await db.insert(unmatchedSmsMessagesTable).values({ threadId: thread.id, direction: "inbound", body: "My name is Synthetic" }).returning();
    await db.update(unmatchedSmsThreadsTable).set({ pendingInboundId: message.id }).where(eq(unmatchedSmsThreadsTable.id, thread.id));
    await sweepPendingUnmatchedSms();
    expect(mocks.send).toHaveBeenCalledWith(number, "What is your email?");
    expect((await threadFor(number)).pendingInboundId).toBeNull();
  });

  it("holds uncertain sends for staff and never automatically resends", async () => {
    const number = phone();
    mocks.send.mockRejectedValueOnce(new Error("connection lost after possible acceptance"));
    const first = await recordAndClassifyUnmatchedSms(number, "My name is Synthetic");
    await recordAndClassifyUnmatchedSms(number, "Did you get that?");
    await resumeUnmatchedSms(first.id);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.classify).toHaveBeenCalledTimes(1);
    expect((await threadFor(number)).onboardingHeld).toBe(true);
    expect((await threadFor(number)).pendingInboundId).not.toBeNull();
    await sendUnmatchedInboundSmsReply(first.id, "A staff member is helping now.");
    expect((await threadFor(number)).onboardingHeld).toBe(false);
    expect((await threadFor(number)).pendingInboundId).toBeNull();
  });

  it("keeps identity matching on human review even when a stale draft proposed onboarding", async () => {
    const number = phone();
    const unique = crypto.randomUUID();
    const [customer] = await db.insert(customersTable).values({ firstName: "Synthetic", lastName: unique, email: `${unique}@example.com`, leadReceivedDate: "2026-09-23" }).returning();
    const started = deferred<void>();
    const draft = deferred<ReturnType<typeof result>>();
    mocks.classify.mockImplementationOnce(() => { started.resolve(); return draft.promise; });
    mocks.classify.mockResolvedValue(result({ senderEmail: customer.email }));
    const first = recordAndClassifyUnmatchedSms(number, "I need help");
    await started.promise;
    const second = recordAndClassifyUnmatchedSms(number, customer.email);
    try { await waitForInbound(number, 2); }
    finally { draft.resolve(result()); }
    await Promise.all([first, second]);
    const thread = await threadFor(number);
    expect(thread.suggestedMatchCustomerId).toBe(customer.id);
    expect(thread.linkedCustomerId).toBeNull();
    expect(thread.aiSummary).toContain("Identity verification required.");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
  });
});

// Business-flow fixtures run during allowed hours; quiet-hours boundaries
// and overnight deferral are exercised in scheduled-sms-quiet-hours.service.test.ts.
vi.mock("../lib/send-window.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/send-window.js")>();
  return { ...actual, isScheduledSmsTime: () => true, assertScheduledSmsTime: () => {} };
});
