import { describe, expect, it } from "vitest";
import { selectRepeatQuestionAnswer } from "./repeat-question-answer.js";

const approved = { source: "model", preCheckCode: null, requiresStaff: false, action: "reply", reply: "Your order is still under review with the doctor." };

describe("selectRepeatQuestionAnswer", () => {
  it("keeps a substantive approved answer unchanged", () => {
    expect(selectRepeatQuestionAnswer(approved, null)).toBe(approved.reply);
  });
  it.each([null, "", "Got it, thanks.", "Thanks for letting me know.", "Just to clarify before we move forward.", "Here are your options.", "Please confirm your delivery address.", "Your order shipped. Has your address changed?", "Here are the details:"])("withholds filler, question setup, or embedded questions: %s", (reply) => {
    expect(selectRepeatQuestionAnswer({ ...approved, reply }, null)).toBeNull();
  });
  it.each([
    { preCheckCode: "PROHIBITED_CLINICAL" }, { requiresStaff: true },
    { source: "pre_check_block" }, { action: "staff_review" }, { action: "no_reply" },
  ])("does not salvage safety exceptions or escalations: %j", (patch) => {
    expect(selectRepeatQuestionAnswer({ ...approved, ...patch }, null)).toBeNull();
  });
  it("does not repeat the previous main answer", () => {
    expect(selectRepeatQuestionAnswer(approved, "YOUR ORDER IS STILL UNDER REVIEW WITH THE DOCTOR!")).toBeNull();
  });
});
