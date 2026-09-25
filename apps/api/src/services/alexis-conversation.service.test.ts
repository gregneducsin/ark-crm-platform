import { eq } from "drizzle-orm";
import { intakeLinkTokensTable } from "@luma/db";
import { describe, it, expect, vi, beforeAll } from "vitest";
import { db, customersTable } from "@luma/db";
import type { ClaudeInteractiveResult, BotPreviewRequestBody } from "../lib/messaging/types.js";
import { ProviderError } from "../lib/messaging/provider.js";

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
      planLength: null,
      dosagePreference: null,
      startTimingPreference: null,
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
it.each(["Got it, thanks. What state are you in?", "Got it, thanks. One more thing, what state are you in"])("deduplicates the follow-up before safety validation: %s", async (reply) => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValue(modelResult({ reply, nextQuestion: "What state are you in?" }));
    const result = await runAlexisTurn(await seedCustomer(), baseBody());
    expect(callClaudeInteractiveMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, reply: "Got it, thanks.", nextQuestion: "What state are you in?", requiresStaff: false, preCheckCode: null });
  });

  it("still rejects unsafe content in a duplicated follow-up", async () => {
    callClaudeInteractiveMock.mockClear();
    const nextQuestion = "Can you open https://unapproved.example.com now?";
    callClaudeInteractiveMock.mockResolvedValue(modelResult({ reply: "Thanks. " + nextQuestion, nextQuestion }));
    const result = await runAlexisTurn(await seedCustomer(), baseBody());
    expect(result).toMatchObject({ ok: false, code: "UNAPPROVED_URL" });
  });

  it("still rejects unsafe main text after removing a safe duplicate", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValue(modelResult({ reply: "Visit https://unapproved.example.com. What state are you in?", nextQuestion: "What state are you in?" }));
    const result = await runAlexisTurn(await seedCustomer(), baseBody());
    expect(result).toMatchObject({ ok: false, code: "UNAPPROVED_URL" });
  });
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

  it("fails closed with the guardrail's rejection code when post-check rejects the model's reply on every attempt", async () => {
    callClaudeInteractiveMock.mockClear();
    // "We accept insurance." is always blocked regardless of topic — a
    // genuine content violation, not a citation slip — so it still fails
    // the same way on every retry attempt, unlike the citation-slip case
    // covered below.
    callClaudeInteractiveMock.mockResolvedValue(modelResult({ reply: "We accept insurance.", knowledgeTopicsUsed: ["insurance_payment"] }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(callClaudeInteractiveMock.mock.calls.length).toBeGreaterThanOrEqual(2);
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

  it("keeps linkProvided sticky once true, even when a later turn's own self-report says false", async () => {
    callClaudeInteractiveMock.mockClear();
    // Preserve the previously recorded link state when a later model response reports false.
    callClaudeInteractiveMock.mockResolvedValueOnce(modelResult({ action: "reply", reply: "You're welcome!", nextQuestion: "Anything else?", linkProvided: false }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody({ messages: [{ direction: "inbound", body: "Ty" }], linkProvided: true }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.linkProvided).toBe(true);
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

  it("sends the reply with no follow-up question once MISSING_NEXT_QUESTION exhausts every retry, rather than silence", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValue(modelResult({ reply: "We serve your state.", nextQuestion: null }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(callClaudeInteractiveMock).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reply).toBe("We serve your state.");
      expect(result.nextQuestion).toBeNull();
      expect(result.requiresStaff).toBe(true);
      expect(result.preCheckCode).toBe("MISSING_NEXT_QUESTION");
    }
  });

  it("sends the repeated draft anyway once REPEATED_DRAFT exhausts every retry, rather than silence", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValue(modelResult({ reply: "Same as before." }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody({ lastDraft: "Same as before." }));

    expect(callClaudeInteractiveMock).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reply).toBe("Same as before.");
      expect(result.requiresStaff).toBe(true);
      expect(result.preCheckCode).toBe("REPEATED_DRAFT");
    }
  });

  it("retries up to the attempt cap on a question mark embedded in reply, with corrective feedback, and sends it as drafted anyway once exhausted", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValue(modelResult({ reply: "Which one would you like, semaglutide or tirzepatide?" }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(callClaudeInteractiveMock).toHaveBeenCalledTimes(3);
    const retryNote = callClaudeInteractiveMock.mock.calls[1][2];
    expect(retryNote).toMatch(/nextQuestion/i);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reply).toBe("Which one would you like, semaglutide or tirzepatide?");
      expect(result.requiresStaff).toBe(true);
      expect(result.preCheckCode).toBe("QUESTION_MARK_IN_REPLY");
    }
  });

  it("still fails closed with no bypass when something else is also wrong with the reply, not just the clinical-citation gate", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValue(
      modelResult({ reply: "We can get your treatment started, and we guarantee results.", knowledgeTopicsUsed: [] }),
    );
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(callClaudeInteractiveMock).toHaveBeenCalledTimes(5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNAPPROVED_URL");
  });

  it("retries an unsupported-pricing-claim rejection once, with corrective feedback, and succeeds if the retry cites the topic", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock
      .mockResolvedValueOnce(modelResult({ reply: "Starting at $120 for the first month.", knowledgeTopicsUsed: [] }))
      .mockResolvedValueOnce(modelResult({ reply: "Starting at $120 for the first month.", knowledgeTopicsUsed: ["semaglutide_pricing"] }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(callClaudeInteractiveMock).toHaveBeenCalledTimes(2);
    // The retry call is the (body, knowledgeCatalog, retryNote) triple —
    // the third argument is the corrective feedback.
    const retryNote = callClaudeInteractiveMock.mock.calls[1][2];
    expect(retryNote).toMatch(/knowledge topic/i);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reply).toBe("Starting at $120 for the first month.");
  });

  it("never bypasses PROHIBITED_CLINICAL_ABSOLUTE (diagnose/contraindicated/symptom) — no amount of retrying waives it", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValue(modelResult({ reply: "I can diagnose your condition." }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(callClaudeInteractiveMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PROHIBITED_CLINICAL_ABSOLUTE");
  });

  it("retries a prohibited-clinical rejection once, with corrective feedback, and succeeds if the retry cites the required topic", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock
      .mockResolvedValueOnce(modelResult({ reply: "We can get your treatment started once you're set up.", knowledgeTopicsUsed: [] }))
      .mockResolvedValueOnce(modelResult({ reply: "We can get your treatment started once you're set up.", knowledgeTopicsUsed: ["titration"] }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(callClaudeInteractiveMock).toHaveBeenCalledTimes(2);
    const retryNote = callClaudeInteractiveMock.mock.calls[1][2];
    expect(retryNote).toMatch(/clinical/i);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reply).toBe("We can get your treatment started once you're set up.");
  });

  it("sends Alexis's own reply anyway (never a substitute or silence) once every retry is exhausted, still flagging staff to double-check it", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValue(modelResult({ reply: "We can get your treatment started once you're set up.", knowledgeTopicsUsed: [] }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(callClaudeInteractiveMock).toHaveBeenCalledTimes(5);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reply).toBe("We can get your treatment started once you're set up.");
      expect(result.requiresStaff).toBe(true);
      expect(result.preCheckCode).toBe("PROHIBITED_CLINICAL");
    }
  });

  it("does not retry a genuinely non-retryable safety rejection (e.g. an unapproved URL)", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockResolvedValueOnce(modelResult({ reply: "Check out https://not-approved.example.com for more info." }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(callClaudeInteractiveMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNAPPROVED_URL");
  });

  it("retries an unsupported-pricing-claim rejection once, with corrective feedback, and succeeds if the retry cites the topic — same fix as the Luma sibling app (Karen/kstaaf57): the bot tried to quote a price right after the customer picked a product but forgot to cite the pricing topic, and froze with no second attempt until a human intervened", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock
      .mockResolvedValueOnce(modelResult({ reply: "Starting at $169 for the first month.", knowledgeTopicsUsed: [] }))
      .mockResolvedValueOnce(modelResult({ reply: "Starting at $169 for the first month.", knowledgeTopicsUsed: ["semaglutide_pricing"] }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(callClaudeInteractiveMock).toHaveBeenCalledTimes(2);
    // The retry call is the (body, knowledgeCatalog, retryNote) triple —
    // the third argument is the corrective feedback.
    const retryNote = callClaudeInteractiveMock.mock.calls[1][2];
    expect(retryNote).toMatch(/knowledge topic/i);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reply).toBe("Starting at $169 for the first month.");
  });

  it("still fails closed after exhausting retries when the pricing claim is genuinely wrong, not just missing a citation", async () => {
    callClaudeInteractiveMock.mockClear();
    // $999 is not one of the approved dollar amounts at all — citing the
    // topic doesn't fix an actually-wrong number, so this keeps failing
    // even with the corrective retry note.
    callClaudeInteractiveMock.mockResolvedValue(modelResult({ reply: "Starting at $999 for the first month.", knowledgeTopicsUsed: ["semaglutide_pricing"] }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(callClaudeInteractiveMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNSUPPORTED_PRICING_CLAIM");
  });

  it("retries a SCHEMA_VALIDATION_ERROR with the specific ZodError issues fed back, and succeeds once the retry fixes it", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock
      .mockRejectedValueOnce(new ProviderError("SCHEMA_VALIDATION_ERROR", '{"reply":"way too long..."}', undefined, "reply: String must contain at most 400 character(s)"))
      .mockResolvedValueOnce(modelResult({ reply: "Shorter answer now." }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(callClaudeInteractiveMock).toHaveBeenCalledTimes(2);
    const retryNote = callClaudeInteractiveMock.mock.calls[1][2];
    expect(retryNote).toMatch(/400 character/i);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reply).toBe("Shorter answer now.");
  });

  it("still fails closed (no reply exists to fall back to) once SCHEMA_VALIDATION_ERROR exhausts every retry", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockRejectedValue(new ProviderError("SCHEMA_VALIDATION_ERROR", "{}", undefined, "action: Invalid enum value"));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(callClaudeInteractiveMock).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SCHEMA_VALIDATION_ERROR");
  });

  it("retries a transient PROVIDER_HTTP_ERROR (no corrective note needed) and succeeds on the retry", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockRejectedValueOnce(new ProviderError("PROVIDER_HTTP_ERROR")).mockResolvedValueOnce(modelResult());
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(callClaudeInteractiveMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it("never retries PROVIDER_NOT_CONFIGURED — a real misconfiguration would just fail identically every time", async () => {
    callClaudeInteractiveMock.mockClear();
    callClaudeInteractiveMock.mockRejectedValue(new ProviderError("PROVIDER_NOT_CONFIGURED"));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody());

    expect(callClaudeInteractiveMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PROVIDER_NOT_CONFIGURED");
  });
});

describe("explicit plan confirmation", () => {
  it("retries an inferred selection and accepts a clarification without saving a plan", async () => {
    callClaudeInteractiveMock.mockReset();
    callClaudeInteractiveMock.mockResolvedValueOnce(modelResult({ slotUpdates: { planLength: "3_month" } }))
      .mockResolvedValueOnce(modelResult({ nextQuestion: "Would you like the 3-month plan?" }));
    const result = await runAlexisTurn(await seedCustomer(), baseBody({
      messages: [{ direction: "inbound", body: "Whatever you think" }],
    }));
    expect(callClaudeInteractiveMock).toHaveBeenCalledTimes(2);
    expect(callClaudeInteractiveMock.mock.calls[1][2]).toContain("not explicitly confirmed");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.validatedSlotUpdates).not.toHaveProperty("planLength");
  });

  it("fails closed before minting a signup link if every attempt invents a plan selection", async () => {
    callClaudeInteractiveMock.mockReset();
    callClaudeInteractiveMock.mockResolvedValue(modelResult({ action: "send_form", nextQuestion: null, slotUpdates: { planLength: "3_month" } }));
    const personId = await seedCustomer();
    const result = await runAlexisTurn(personId, baseBody({ messages: [{ direction: "inbound", body: "I'm unsure" }] }));
    expect(result).toEqual({ ok: false, code: "UNCONFIRMED_PLAN_SELECTION" });
    expect(callClaudeInteractiveMock).toHaveBeenCalledTimes(3);
    const tokens = await db.select().from(intakeLinkTokensTable).where(eq(intakeLinkTokensTable.personId, personId));
    expect(tokens).toHaveLength(0);
  });
});
