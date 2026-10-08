import { describe, it, expect, vi } from "vitest";
import type { SophieInteractiveResult } from "../lib/support/types.js";
import type { SophiePreviewRequestBody } from "../lib/support/types.js";

const callSophieInteractiveMock = vi.fn();
vi.mock("../lib/support/provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/support/provider.js")>("../lib/support/provider.js");
  return {
    ...actual,
    callSophieInteractive: (...args: unknown[]) => callSophieInteractiveMock(...args),
  };
});

const { SophieProviderError } = await import("../lib/support/provider.js");
const { runSophieTurn } = await import("./sophie-conversation.service.js");

function baseBody(overrides: Partial<SophiePreviewRequestBody> = {}): SophiePreviewRequestBody {
  return {
    messages: [{ direction: "inbound", body: "Has my order shipped yet?" }],
    orderState: { prescriptionWritten: false, orderShipped: false, trackingNumber: null, paymentFailed: false },
    reviewRequested: false,
    lastQuestion: null,
    pendingTopic: null,
    lastDraft: null,
    ...overrides,
  };
}

function modelResult(overrides: Partial<SophieInteractiveResult> = {}): SophieInteractiveResult {
  return {
    action: "reply",
    reply: "Your order hasn't shipped yet, the doctor is still reviewing it.",
    confidence: 0.9,
    detectedIntents: [],
    knowledgeTopicsUsed: [],
    requiresStaff: false,
    safetyCodes: [],
    nextQuestion: "Is there anything else I can help with?",
    inboundSentiment: "neutral",
    ...overrides,
  };
}

describe("runSophieTurn", () => {
  it("acknowledges a stated plan without asking the customer to repeat it", async () => {
    callSophieInteractiveMock.mockClear();
    const result = await runSophieTurn(baseBody({ messages: [{ direction: "inbound", body: "No issues so far. Not as much as I hoped but we'll give it a go for the next couple of weeks." }] }));
    expect(result).toMatchObject({ ok: true, action: "pause", nextQuestion: null, requiresStaff: false });
    expect(callSophieInteractiveMock).not.toHaveBeenCalled();
  });
  it("acknowledges bot timing feedback and requests human review", async () => {
    callSophieInteractiveMock.mockClear();
    const result = await runSophieTurn(baseBody({ messages: [{ direction: "inbound", body: "A recommendation for whoever reviews this: your AI chat bot replies too fast and acts like a person. As I said, we'll stick with the plan." }] }));
    expect(result).toMatchObject({ ok: true, action: "staff_review", nextQuestion: null, requiresStaff: true, preCheckCode: "MESSAGING_FEEDBACK" });
    expect(callSophieInteractiveMock).not.toHaveBeenCalled();
  });
  it("keeps medical safety checks ahead of conversational closure", async () => {
    const result = await runSophieTurn(baseBody({ messages: [{ direction: "inbound", body: "We'll continue but I am having side effects." }] }));
    expect(result).toMatchObject({ ok: true, requiresStaff: true, preCheckCode: "PRESCRIPTION_QUESTION" });
  });
  it("does not close a stated plan when it also includes an unresolved request", async () => {
    callSophieInteractiveMock.mockClear();
    callSophieInteractiveMock.mockResolvedValueOnce(modelResult({ reply: "You can check the tracking in your patient portal.", nextQuestion: null }));
    await runSophieTurn(baseBody({ messages: [{ direction: "inbound", body: "We'll continue for a few weeks. I need my tracking number" }] }));
    expect(callSophieInteractiveMock).toHaveBeenCalledTimes(1);
  });
  it("retains messaging feedback when a second inbound is coalesced with it", async () => {
    const result = await runSophieTurn(baseBody({ messages: [
      { direction: "inbound", body: "Your chatbot replies too fast and acts like a person." },
      { direction: "inbound", body: "Anyway, thanks." },
    ] }));
    expect(result).toMatchObject({ ok: true, requiresStaff: true, preCheckCode: "MESSAGING_FEEDBACK", nextQuestion: null });
  });
  it("strips a generic 'anything else' follow-up from a model turn", async () => {
    callSophieInteractiveMock.mockClear();
    callSophieInteractiveMock.mockResolvedValueOnce(modelResult({ nextQuestion: "Is there anything else I can help with?" }));
    const result = await runSophieTurn(baseBody());
    expect(result).toMatchObject({ ok: true, nextQuestion: null });
  });
it.each(["Got it, thanks. What state are you in?", "Got it, thanks. One more thing, what state are you in"])("deduplicates the follow-up before safety validation: %s", async (reply) => {
    callSophieInteractiveMock.mockClear();
    callSophieInteractiveMock.mockResolvedValue(modelResult({ reply, nextQuestion: "What state are you in?" }));
    const result = await runSophieTurn(baseBody());
    expect(callSophieInteractiveMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, reply: "Got it, thanks.", nextQuestion: "What state are you in?", requiresStaff: false, preCheckCode: null });
  });

  it("still rejects unsafe content in a duplicated follow-up", async () => {
    callSophieInteractiveMock.mockClear();
    const nextQuestion = "Can you open https://unapproved.example.com now?";
    callSophieInteractiveMock.mockResolvedValue(modelResult({ reply: "Thanks. " + nextQuestion, nextQuestion }));
    const result = await runSophieTurn(baseBody());
    expect(result).toMatchObject({ ok: false, code: "UNAPPROVED_URL" });
  });

  it("still rejects unsafe main text after removing a safe duplicate", async () => {
    callSophieInteractiveMock.mockClear();
    callSophieInteractiveMock.mockResolvedValue(modelResult({ reply: "Visit https://unapproved.example.com. What state are you in?", nextQuestion: "What state are you in?" }));
    const result = await runSophieTurn(baseBody());
    expect(result).toMatchObject({ ok: false, code: "UNAPPROVED_URL" });
  });
  it("short-circuits on a pre-check block without ever calling the provider", async () => {
    callSophieInteractiveMock.mockClear();
    const result = await runSophieTurn(baseBody({ messages: [{ direction: "inbound", body: "STOP" }] }));

    expect(callSophieInteractiveMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("pause");
      expect(result.source).toBe("pre_check_block");
      expect(result.preCheckCode).toBe("OPT_OUT");
    }
  });

  it("routes a prescription question to staff_review via pre-check, no provider call, but still replies with the patient portal instead of leaving the patient in silence", async () => {
    callSophieInteractiveMock.mockClear();
    const result = await runSophieTurn(baseBody({ messages: [{ direction: "inbound", body: "what dosage am I on" }] }));

    expect(callSophieInteractiveMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("staff_review");
      expect(result.requiresStaff).toBe(true);
      expect(result.reply).toMatch(/portal/i);
      expect(result.reply).toContain("https://patient.tryark.com/login");
      expect(result.preCheckCode).toBe("PRESCRIPTION_QUESTION");
    }
  });

  it("routes a cold-chain concern to staff_review via pre-check, no provider call, but still points the patient to the portal instead of leaving them in silence", async () => {
    callSophieInteractiveMock.mockClear();
    const result = await runSophieTurn(
      baseBody({ messages: [{ direction: "inbound", body: "One ice pack on one side. Hot to the touch providing no refrigeration at all!" }] }),
    );

    expect(callSophieInteractiveMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("staff_review");
      expect(result.requiresStaff).toBe(true);
      expect(result.reply).toMatch(/portal/i);
      expect(result.reply).toContain("https://patient.tryark.com/login");
      expect(result.preCheckCode).toBe("COLD_CHAIN_CONCERN");
    }
  });

  it("routes a request to pause/hold a prescription to staff_review via pre-check, no provider call, points to the portal, and never confirms the pause happened", async () => {
    callSophieInteractiveMock.mockClear();
    const result = await runSophieTurn(baseBody({ messages: [{ direction: "inbound", body: "can you pause my prescription for a couple months" }] }));

    expect(callSophieInteractiveMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("staff_review");
      expect(result.requiresStaff).toBe(true);
      expect(result.reply).toMatch(/portal/i);
      expect(result.reply).toContain("https://patient.tryark.com/login");
      // Never a confirmation that the pause happened — Sophie has no way to
      // action it, only to point at the portal and flag a person.
      expect(result.reply).not.toMatch(/paused|has been paused|you're paused|is paused/i);
      expect(result.preCheckCode).toBe("PAUSE_PRESCRIPTION_REQUEST");
    }
  });

  it("responds with a real 911 message on emergency content, and still flags staff attention", async () => {
    callSophieInteractiveMock.mockClear();
    const result = await runSophieTurn(baseBody({ messages: [{ direction: "inbound", body: "this is an emergency" }] }));

    expect(callSophieInteractiveMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("staff_review");
      expect(result.requiresStaff).toBe(true);
      expect(result.reply).toMatch(/call 911/i);
      expect(result.preCheckCode).toBe("EMERGENCY_CONTENT");
    }
  });

  it("does not set preCheckCode on a model-generated turn", async () => {
    callSophieInteractiveMock.mockClear();
    callSophieInteractiveMock.mockResolvedValueOnce(modelResult());
    const result = await runSophieTurn(baseBody());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preCheckCode).toBeNull();
    }
  });

  it("fails closed with the guardrail's rejection code when post-check rejects the model's reply", async () => {
    callSophieInteractiveMock.mockClear();
    callSophieInteractiveMock.mockResolvedValueOnce(modelResult({ reply: "Your semaglutide dose is being increased." }));
    const result = await runSophieTurn(baseBody());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PROHIBITED_CLINICAL");
  });

  it("retries malformed questions but allows the eventual answer without a question", async () => {
    callSophieInteractiveMock.mockClear();
    callSophieInteractiveMock
      .mockResolvedValueOnce(modelResult({ nextQuestion: "Which order" }))
      .mockResolvedValueOnce(modelResult({ nextQuestion: "Anything else I can help with?" }));
    const result = await runSophieTurn(baseBody());

    expect(callSophieInteractiveMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nextQuestion).toBeNull();
  });

  it("does not retry a safety-relevant rejection", async () => {
    callSophieInteractiveMock.mockClear();
    callSophieInteractiveMock.mockResolvedValueOnce(modelResult({ reply: "Side effects are common." }));
    const result = await runSophieTurn(baseBody());

    expect(callSophieInteractiveMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PROHIBITED_CLINICAL");
  });

  it("passes through action=staff_review and requiresStaff from the model", async () => {
    callSophieInteractiveMock.mockClear();
    callSophieInteractiveMock.mockResolvedValueOnce(
      modelResult({ action: "staff_review", reply: null, nextQuestion: null, requiresStaff: true }),
    );
    const result = await runSophieTurn(baseBody());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("staff_review");
      expect(result.requiresStaff).toBe(true);
    }
  });
});

describe("Sophie malformed provider recovery", () => {
  it("passes field-specific feedback into the next attempt", async () => {
    callSophieInteractiveMock.mockReset();
    callSophieInteractiveMock.mockRejectedValueOnce(new SophieProviderError("SCHEMA_VALIDATION_ERROR", "", undefined, ["reply: too_big"]))
      .mockResolvedValueOnce(modelResult());
    expect(await runSophieTurn(baseBody())).toMatchObject({ ok: true });
    expect(callSophieInteractiveMock.mock.calls[1][2]).toBe("reply: too_big");
  });
  it("retries truncated output within the same bounded attempt budget", async () => {
    callSophieInteractiveMock.mockReset();
    callSophieInteractiveMock.mockRejectedValue(new SophieProviderError("TRUNCATED_RESPONSE"));
    expect(await runSophieTurn(baseBody())).toEqual({ ok: false, code: "TRUNCATED_RESPONSE" });
    expect(callSophieInteractiveMock).toHaveBeenCalledTimes(3);
  });

  it.each(["SCHEMA_VALIDATION_ERROR", "EMPTY_RESPONSE", "NO_JSON_OBJECT", "JSON_PARSE_ERROR"])("repairs %s and validates the result", async (code) => {
    callSophieInteractiveMock.mockReset();
    callSophieInteractiveMock.mockRejectedValueOnce(new SophieProviderError(code)).mockResolvedValueOnce(modelResult());
    expect(await runSophieTurn(baseBody())).toMatchObject({ ok: true });
    expect(callSophieInteractiveMock).toHaveBeenCalledTimes(2);
    expect(callSophieInteractiveMock.mock.calls[1][2]).toBe(true);
  });
  it("stops after three invalid responses for staff escalation", async () => {
    callSophieInteractiveMock.mockReset();
    callSophieInteractiveMock.mockRejectedValue(new SophieProviderError("SCHEMA_VALIDATION_ERROR"));
    expect(await runSophieTurn(baseBody())).toEqual({ ok: false, code: "SCHEMA_VALIDATION_ERROR" });
    expect(callSophieInteractiveMock).toHaveBeenCalledTimes(3);
  });
  it("blocks unsafe content returned during repair", async () => {
    callSophieInteractiveMock.mockReset();
    callSophieInteractiveMock.mockRejectedValueOnce(new SophieProviderError("SCHEMA_VALIDATION_ERROR"))
      .mockResolvedValueOnce(modelResult({ reply: "Your semaglutide dose is being increased." }));
    expect(await runSophieTurn(baseBody())).toMatchObject({ ok: false, code: "PROHIBITED_CLINICAL", rejectedDraft: expect.stringContaining("dose is being increased") });
    expect(callSophieInteractiveMock).toHaveBeenCalledTimes(2);
  });
  it.each(["PROVIDER_NOT_CONFIGURED", "PROVIDER_TIMEOUT", "PROVIDER_HTTP_ERROR"])("does not retry %s", async code => {
    callSophieInteractiveMock.mockReset();
    callSophieInteractiveMock.mockRejectedValue(new SophieProviderError(code));
    expect(await runSophieTurn(baseBody())).toEqual({ ok: false, code });
    expect(callSophieInteractiveMock).toHaveBeenCalledTimes(1);
  });
});

describe("account action handoff", () => {
  it("routes a shipment reschedule without asking the model or confirming completion", async () => {
    callSophieInteractiveMock.mockClear();
    const result = await runSophieTurn(baseBody({ messages: [{ direction: "inbound", body: "Please reschedule my shipment for Friday" }] }));
    expect(callSophieInteractiveMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, action: "staff_review", requiresStaff: true, preCheckCode: "ACCOUNT_CHANGE_REQUEST", nextQuestion: null });
    if (result.ok) expect(result.reply).toContain("No account change has been made by this chat");
  });
  it("rejects an invented completed action without retrying it", async () => {
    callSophieInteractiveMock.mockReset().mockResolvedValueOnce(modelResult({ reply: "I have rescheduled your shipment for Friday.", nextQuestion: null }));
    const result = await runSophieTurn(baseBody());
    expect(result).toMatchObject({ ok: false, code: "UNVERIFIED_ACCOUNT_ACTION" });
    expect(callSophieInteractiveMock).toHaveBeenCalledTimes(1);
  });
});
