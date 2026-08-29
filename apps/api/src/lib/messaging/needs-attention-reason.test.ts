import { describe, it, expect } from "vitest";
import { describeNeedsAttentionReason } from "./needs-attention-reason.js";

describe("describeNeedsAttentionReason", () => {
  it("explains an unexpected exception", () => {
    expect(describeNeedsAttentionReason({ kind: "exception" })).toMatch(/unexpected system error/i);
  });

  it("maps a known rejection code to its specific explanation", () => {
    expect(describeNeedsAttentionReason({ kind: "rejected", code: "PROHIBITED_CLINICAL" })).toMatch(/clinical\/medical language/i);
  });

  it("falls back to a generic explanation for an unmapped rejection code", () => {
    expect(describeNeedsAttentionReason({ kind: "rejected", code: "SOME_NEW_CODE" })).toBe(
      "The draft reply was rejected by an automatic check (SOME_NEW_CODE) and nothing was sent.",
    );
  });

  it("maps a known staff-flagged pre-check code to its specific explanation", () => {
    expect(describeNeedsAttentionReason({ kind: "staff_flagged", preCheckCode: "EMERGENCY_CONTENT" })).toMatch(/medical emergency/i);
  });

  it("maps SIDE_EFFECT_REPORT to its specific explanation", () => {
    expect(describeNeedsAttentionReason({ kind: "staff_flagged", preCheckCode: "SIDE_EFFECT_REPORT" })).toMatch(/side effects/i);
  });

  it("maps PAUSE_PRESCRIPTION_REQUEST to its specific explanation", () => {
    expect(describeNeedsAttentionReason({ kind: "staff_flagged", preCheckCode: "PAUSE_PRESCRIPTION_REQUEST" })).toMatch(/pause, hold, or skip/i);
  });

  it("falls back to a generic explanation for an unmapped staff-flagged code", () => {
    expect(describeNeedsAttentionReason({ kind: "staff_flagged", preCheckCode: "SOME_NEW_CODE" })).toBe("Flagged for a person to review (SOME_NEW_CODE).");
  });

  it("explains a null pre-check code (Claude itself routed to staff)", () => {
    expect(describeNeedsAttentionReason({ kind: "staff_flagged", preCheckCode: null })).toMatch(/didn't clearly fit any of the approved scripts/i);
  });
});
