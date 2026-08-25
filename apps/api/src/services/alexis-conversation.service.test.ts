import { describe, it, expect, vi, beforeAll } from "vitest";
import { db, customersTable } from "@luma/db";
import type { ClaudeInteractiveResult, BotPreviewRequestBody } from "../lib/messaging/types.js";

beforeAll(() => {
  process.env.INTAKE_LINK_BASE_URL = "http://localhost:3000";
});

const callClaudeInteractiveMock = vi.fn();
vi.mock("../lib/messaging/provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/messaging/provider.js")>("../lib/messaging/provider.js");
  return {
    ...actual,
    callClaudeInteractive: (...args: unknown[]) => callClaudeInteractiveMock(...args),
  };
});

const { runAlexisTurn } = await import("./alexis-conversation.service.js");

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName: "Alexis", lastName: "Test", email: `alexis-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" })
    .returning({ id: customersTable.id });
  return row.id;
}

function baseBody(overrides: Partial<BotPreviewRequestBody> = {}): BotPreviewRequestBody {
  return {
    messages: [{ direction: "inbound", body: "Hi, I'm interested in learning more." }],
    leadSource: "abandoned_cart",
    currentSlots: {
      selectedProduct: null,
      currentlyTaking: null,
      wantsProcessExplanation: null,
      hasTimeForIntake: null,
      wantsPlanInclusions: null,
      readyForForm: null,
      state: null,
    },
    lastQuestion: null,
    pendingTopic: null,
    lastDraft: null,
    objectionStage: 0,
    objectionKey: null,
    linkProvided: false,
    promoOffered: false,
    customerFirstName: "Test",
    ...overrides,
  };
}

function modelResult(overrides: Partial<ClaudeInteractiveResult> = {}): ClaudeInteractiveResult {
  return {
    action: "reply",
    reply: "We offer semaglutide and tirzepatide.",
    confidence: 0.9,
    detectedIntents: [],
    detectedIntent: "unknown",
    knowledgeTopicsUsed: ["product_comparison"],
    requiresStaff: false,
    slotUpdates: {},
    resumeTopic: null,
    safetyCodes: [],
    nextQuestion: "Which one are you leaning toward?",
    linkProvided: false,
    objectionStage: 0,
    objectionKey: null,
    promoOffered: false,
    inboundSentiment: null,
    learnedFirstName: null,
    ...overrides,
  };
}

describe("runAlexisTurn", () => {
  it("short-circuits on a pre-check block without ever calling the provider", async () => {
    callClaudeInteractiveMock.mockClear();
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody({ messages: [{ direction: "inbound", body: "STOP" }] }));

    expect(callClaudeInteractiveMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("pause");
      expect(result.reply).toMatch(/unsubscribed/i);
      expect(result.source).toBe("pre_check_block");
      expect(result.preCheckCode).toBe("OPT_OUT");
    }
  });

  it("routes a suitability question to staff_review via pre-check, no provider call, but still replies instead of leaving the customer in silence", async () => {
    callClaudeInteractiveMock.mockClear();
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody({ messages: [{ direction: "inbound", body: "which one is right for me?" }] }));

    expect(callClaudeInteractiveMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("staff_review");
      expect(result.requiresStaff).toBe(true);
      expect(result.reply).toMatch(/doctor/i);
    }
  });

  it("responds with a real 911 message on emergency content, and still flags staff attention", async () => {
    callClaudeInteractiveMock.mockClear();
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody({ messages: [{ direction: "inbound", body: "I'm having a medical emergency" }] }));

    expect(callClaudeInteractiveMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("staff_review");
      expect(result.requiresStaff).toBe(true);
      expect(result.reply).toMatch(/call 911/i);
      expect(result.preCheckCode).toBe("EMERGENCY_CONTENT");
    }
  });

  it("lets a model-generated turn handle a short topic-naming reply to our own last question, instead of pre-check-blocking it as MEDICAL_CONTENT", async () => {
    // Real production case: Alexis asked "is there something specific about
    // the process you'd like me to go over?" and the customer answered
    // "Medication and plans" — a bare medical-word match on an unprompted
    // question would have blocked this; body.lastQuestion is what tells
    // interactivePreCheck this was actually just answering us.
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValueOnce(modelResult());
    const personId = await seedCustomer();
    const result = await runAlexisTurn(
      personId,
      baseBody({
        messages: [{ direction: "inbound", body: "Medication and plans" }],
        lastQuestion: "Is there something specific about the process you'd like me to go over?",
      }),
    );

    expect(callClaudeInteractiveMock).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("model");
      expect(result.preCheckCode).toBeNull();
    }
  });

  it("still pre-check-blocks a short medical-word reply as MEDICAL_CONTENT when we hadn't asked anything", async () => {
    callClaudeInteractiveMock.mockClear();
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody({ messages: [{ direction: "inbound", body: "Medication and plans" }], lastQuestion: null }));

    expect(callClaudeInteractiveMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("staff_review");
      expect(result.preCheckCode).toBe("MEDICAL_CONTENT");
    }
  });

  it("pre-check-blocks an active side-effect report as SIDE_EFFECT_REPORT, with a reply naming real options for the doctor to review", async () => {
    callClaudeInteractiveMock.mockClear();
    const personId = await seedCustomer();
    const result = await runAlexisTurn(
      personId,
      baseBody({ messages: [{ direction: "inbound", body: "It makes my stomach hurt and sometimes I throw up in the morning. And I have diarrhea sometimes." }] }),
    );

    expect(callClaudeInteractiveMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("staff_review");
      expect(result.preCheckCode).toBe("SIDE_EFFECT_REPORT");
      expect(result.reply).toMatch(/doctor/i);
      expect(result.reply).toMatch(/zofran|dose/i);
    }
  });

  it("does not set preCheckCode on a model-generated turn", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValueOnce(modelResult());
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preCheckCode).toBeNull();
    }
  });

  it("fails closed with the guardrail's rejection code when post-check rejects the model's reply", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValueOnce(modelResult({ reply: "We accept insurance.", knowledgeTopicsUsed: ["insurance_payment"] }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNSUPPORTED_PRICING_CLAIM");
  });

  it("rejects a knowledge topic the model wasn't permitted to use this turn", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValueOnce(modelResult({ knowledgeTopicsUsed: ["some_future_unenabled_topic"] }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNKNOWN_KNOWLEDGE_TOPIC");
  });

  it("mints a real per-lead intake link on action=send_form and appends it to the reply, never trusting a model-supplied URL", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValueOnce(
      modelResult({ action: "send_form", reply: "Perfect, sending you the signup link now.", nextQuestion: null, knowledgeTopicsUsed: [] }),
    );
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("send_form");
      expect(result.link).toMatch(/^http:\/\/localhost:3000\/go\/.+/);
      expect(result.reply).toContain(result.link as string);
      expect(result.reply).toContain("Affirm");
      expect(result.linkProvided).toBe(true);
    }
  });

  it("fails soft when minting the intake link throws (e.g. INTAKE_LINK_BASE_URL misconfigured) — still replies, without a link, and flags staff attention", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValueOnce(
      modelResult({ action: "send_form", reply: "Perfect, sending you the signup link now.", nextQuestion: null, knowledgeTopicsUsed: [] }),
    );
    const personId = await seedCustomer();

    const saved = process.env.INTAKE_LINK_BASE_URL;
    delete process.env.INTAKE_LINK_BASE_URL;
    try {
      const result = await runAlexisTurn(personId, baseBody());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.action).toBe("send_form");
        expect(result.link).toBeNull();
        expect(result.reply).toBe("Perfect, sending you the signup link now.");
        expect(result.requiresStaff).toBe(true);
      }
    } finally {
      process.env.INTAKE_LINK_BASE_URL = saved;
    }
  });

  it("passes through the objection stage the model reports", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValueOnce(modelResult({ objectionStage: 1 }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody({ objectionStage: 0 }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.objectionStage).toBe(1);
  });

  it("retries once on a format-only rejection (MISSING_NEXT_QUESTION) and succeeds on the second attempt", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock
      .mockResolvedValueOnce(modelResult({ nextQuestion: null }))
      .mockResolvedValueOnce(modelResult({ nextQuestion: "Which plan works for you?" }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(callClaudeInteractiveMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nextQuestion).toBe("Which plan works for you?");
  });

  it("retries up to the attempt cap on a question mark embedded in reply, and fails closed if every attempt fails", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValue(modelResult({ reply: "Which one would you like — semaglutide or tirzepatide?" }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(callClaudeInteractiveMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("QUESTION_MARK_IN_REPLY");
  });

  it("does not retry a safety-relevant rejection (e.g. an unsupported pricing claim)", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValueOnce(modelResult({ reply: "We accept insurance.", knowledgeTopicsUsed: ["insurance_payment"] }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(callClaudeInteractiveMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNSUPPORTED_PRICING_CLAIM");
  });
});
