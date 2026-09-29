import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, smsReplyWorkTable, unmatchedSmsThreadsTable } from "@luma/db";
const mocks = vi.hoisted(() => ({ sales: vi.fn(), support: vi.fn(), send: vi.fn(), classify: vi.fn() }));
vi.mock("./alexis-conversation.service.js", () => ({ runAlexisTurn: mocks.sales }));
vi.mock("./sophie-conversation.service.js", () => ({ runSophieTurn: mocks.support }));
vi.mock("../lib/sms-provider.js", () => ({ getSmsProvider: () => ({ sendMessage: mocks.send }) }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: mocks.classify }; } }));
vi.mock("../lib/slack.js", () => ({ notifySlack: vi.fn(), notifySmsSlack: vi.fn() }));
import { processInboundMessage, resumeAlexisSms } from "./alexis-dispatch.service.js";
import { processInboundSupportMessage, resumeSophieSms } from "./sophie-dispatch.service.js";
import { recordAndClassifyUnmatchedSms, resumeUnmatchedSms } from "./unmatched-inbound-sms.service.js";
import { getSmsReplyWork } from "./sms-delivery.service.js";
import { isPhoneSmsOptedOut } from "../lib/sms-opt-out.js";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = "synthetic-test-only";
  mocks.send.mockImplementation(async () => ({ providerMessageId: crypto.randomUUID() }));
  const reply = { ok: true, action: "reply", reply: "Thanks for both messages.", nextQuestion: null,
    inboundSentiment: "neutral", requiresStaff: false, knowledgeTopicsUsed: [], source: "model",
    preCheckCode: null, validatedSlotUpdates: {}, objectionStage: 0, objectionKey: null, linkProvided: false, promoOffered: false };
  mocks.sales.mockResolvedValue(reply); mocks.support.mockResolvedValue(reply);
  mocks.classify.mockResolvedValue({ content: [{ type: "tool_use", name: "classify_unmatched_sms", input: {
    intent: "new_lead_interest", senderName: null, senderEmail: null, summary: "Synthetic lead",
    suggestedReply: "What is your name?", matchCandidateIndex: null, matchConfidence: null, needsHumanReview: false,
    confirmsExistingCustomer: false, productCategoryMentioned: "none",
  } }] });
});

describe("real durable reply pacing", () => {
  for (const persona of ["sales", "support"] as const) {
    it(`coalesces rapid ${persona} texts and retains work until the quiet period ends`, async () => {
      const [person] = await db.insert(customersTable).values({ firstName: "Synthetic", lastName: "Pacing",
        email: `${crypto.randomUUID()}@example.com`, phone: "+15551238801", leadReceivedDate: "2026-09-29" }).returning();
      const receive = persona === "sales" ? processInboundMessage : processInboundSupportMessage;
      const resume = persona === "sales" ? resumeAlexisSms : resumeSophieSms;
      const model = persona === "sales" ? mocks.sales : mocks.support;
      expect(await receive(person.id, "First question")).toMatchObject({ code: "REPLY_DEFERRED" });
      const first = await getSmsReplyWork(person.id, persona);
      await db.update(smsReplyWorkTable).set({ updatedAt: new Date(Date.now()-60_000) }).where(eq(smsReplyWorkTable.personId, person.id));
      expect(await receive(person.id, "Second question")).toMatchObject({ code: "REPLY_DEFERRED" });
      expect((await getSmsReplyWork(person.id, persona))?.generation).not.toBe(first?.generation);
      expect(model).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
      await db.update(smsReplyWorkTable).set({ updatedAt: new Date(Date.now()-60_000) }).where(eq(smsReplyWorkTable.personId, person.id));
      expect(await resume(person.id)).toMatchObject({ ok: true });
      expect(model).toHaveBeenCalledTimes(1);
      const body = persona === "sales" ? model.mock.calls[0][1] : model.mock.calls[0][0];
      expect(body.messages.filter((m: { direction: string }) => m.direction === "inbound")).toHaveLength(2);
      expect(mocks.send).toHaveBeenCalledTimes(1);
      await resume(person.id);
      expect(mocks.send).toHaveBeenCalledTimes(1);
    });
  }
  it("waits for both first-time texts before one greeting", async () => {
    const phone = "+15551238802";
    const first = await recordAndClassifyUnmatchedSms(phone, "Hello");
    await db.update(unmatchedSmsThreadsTable).set({ updatedAt: new Date(Date.now()-60_000) }).where(eq(unmatchedSmsThreadsTable.id, first.id));
    await recordAndClassifyUnmatchedSms(phone, "How much does it cost?");
    await resumeUnmatchedSms(first.id);
    expect(mocks.classify).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
    await db.update(unmatchedSmsThreadsTable).set({ updatedAt: new Date(Date.now()-60_000) }).where(eq(unmatchedSmsThreadsTable.id, first.id));
    await resumeUnmatchedSms(first.id);
    expect(mocks.classify).toHaveBeenCalledTimes(1); expect(mocks.send).toHaveBeenCalledTimes(1);
    await resumeUnmatchedSms(first.id);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("records unknown-sender STOP immediately during the quiet period", async () => {
    const phone = "+15551238803";
    await recordAndClassifyUnmatchedSms(phone, "STOP");
    expect(await isPhoneSmsOptedOut(phone)).toBe(true);
    expect(mocks.classify).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  });
});
