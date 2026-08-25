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
