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

  it("retries once on a format-only rejection (MISSING_NEXT_QUESTION) and succeeds on the second attempt", async () => {
    callSophieInteractiveMock.mockClear();
    callSophieInteractiveMock
      .mockResolvedValueOnce(modelResult({ nextQuestion: null }))
      .mockResolvedValueOnce(modelResult({ nextQuestion: "Anything else I can help with?" }));
    const result = await runSophieTurn(baseBody());

    expect(callSophieInteractiveMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nextQuestion).toBe("Anything else I can help with?");
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
    expect(await runSophieTurn(baseBody())).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
    expect(callSophieInteractiveMock).toHaveBeenCalledTimes(2);
  });
  it.each(["PROVIDER_NOT_CONFIGURED", "PROVIDER_TIMEOUT", "PROVIDER_HTTP_ERROR"])("does not retry %s", async code => {
    callSophieInteractiveMock.mockReset();
    callSophieInteractiveMock.mockRejectedValue(new SophieProviderError(code));
    expect(await runSophieTurn(baseBody())).toEqual({ ok: false, code });
    expect(callSophieInteractiveMock).toHaveBeenCalledTimes(1);
  });
});
