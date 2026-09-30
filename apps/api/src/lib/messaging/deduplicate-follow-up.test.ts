import { describe, expect, it } from "vitest";
import { deduplicateFollowUp } from "./deduplicate-follow-up.js";

describe("deduplicateFollowUp", () => {
  it.each([
    "Got it, thanks. What state are you in?",
    "Got it, thanks. what state are you in",
    "Got it, thanks. WHAT   STATE are you in?",
    "Got it, thanks. One more thing, what state are you in",
    "Got it, thanks. To make sure we can serve you, what state are you in",
    "Got it, thanks. What state are you in? What state are you in?",
  ])("preserves the statement and keeps one copy of the question: %s", (reply) => {
    expect(deduplicateFollowUp({ reply, nextQuestion: "What state are you in?" })).toEqual({ reply: "Got it, thanks.", nextQuestion: "What state are you in?" });
  });
  it("keeps only the follow-up when the reply is entirely its duplicate", () => {
    expect(deduplicateFollowUp({ reply: "What state are you in?", nextQuestion: "What state are you in?" }).reply).toBeNull();
  });
  it.each([
    { reply: "Your order is still under review.", nextQuestion: "What state are you in?" },
    { reply: "Which plan length works best for you?", nextQuestion: "Want to see payment plan options?" },
    { reply: "What state are you in? We serve most states.", nextQuestion: "What state are you in?" },
    { reply: "An answer without a follow-up.", nextQuestion: null },
    { reply: "What state are you in?", nextQuestion: "What state are you in" },
    { reply: "See https://example.com/help", nextQuestion: "See https://example.com/help?" },
  ])("does not remove different questions, internal text, or malformed follow-ups: %j", (turn) => {
    expect(deduplicateFollowUp(turn)).toEqual(turn);
  });
});
