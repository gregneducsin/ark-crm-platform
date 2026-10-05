import { describe, it, expect } from "vitest";
import { parseSophieOutput, SophieProviderError } from "./provider.js";
import { supportPostCheck } from "./safety.js";

describe("Sophie structured output recovery", () => {
  it("routes a handoff with accidental draft text to staff without sending it", () => {
    const result = parseSophieOutput({ action: "staff_review", reply: "Your refill date has been changed.", nextQuestion: "Anything else?", confidence: 0.9 });
    expect(result).toMatchObject({ action: "staff_review", requiresStaff: true, reply: null, nextQuestion: null });
  });
  it("accepts a quiet action missing its unused text fields", () => {
    expect(parseSophieOutput({ action: "no_reply", confidence: 0.9 })).toMatchObject({ reply: null, nextQuestion: null });
  });
  it("does not truncate or coerce an invalid customer-facing reply", () => {
    expect(() => parseSophieOutput({ action: "reply", confidence: 0.9, reply: "x".repeat(601) })).toThrow(SophieProviderError);
    expect(() => parseSophieOutput({ action: "reply", confidence: 0.9, reply: null })).toThrow(SophieProviderError);
    expect(() => parseSophieOutput({ action: "reply", confidence: "0.9", reply: "Received." })).toThrow(SophieProviderError);
  });
  it("reports only field names and schema codes, never invalid values", () => {
    try {
      parseSophieOutput({ action: "private-value@example.test", confidence: "private-value@example.test", reply: null });
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SophieProviderError);
      const failure = error as SophieProviderError;
      expect(failure.issues.join(";")).toContain("action:");
      expect(failure.issues.join(";")).toContain("confidence:");
      expect(JSON.stringify(failure)).not.toContain("private-value");
      expect(failure.rawOutput).toBe("");
    }
  });
  it("keeps safety checks on a structurally valid reply", () => {
    const result = parseSophieOutput({ action: "reply", confidence: 0.9, reply: "Your dose should increase." });
    expect(supportPostCheck(result, null)).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
  });
});
