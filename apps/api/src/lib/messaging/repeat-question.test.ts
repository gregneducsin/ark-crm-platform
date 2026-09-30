import { describe, it, expect } from "vitest";
import { countRepeatQuestionsInHistory, countTrailingRepeatQuestions } from "./repeat-question.js";

describe("countTrailingRepeatQuestions", () => {
  it("does not confuse choosing a duration with agreeing to payment-plan information", () => {
    const recent = ["Which plan length works best for you?", "Want to see the payment plan options?"];
    expect(countTrailingRepeatQuestions(recent, "Which plan works best for you?")).toBe(0);
  });

  it("does not join unrelated questions on a single shared word", () => {
    expect(countTrailingRepeatQuestions(["What is your shipping address?"], "What is your email address?")).toBe(0);
  });

  it("still detects repeated short questions", () => {
    expect(countTrailingRepeatQuestions(["Your email?", "What is your email?"], "Email?")).toBe(2);
  });
  it("returns 0 when there is no candidate question", () => {
    expect(countTrailingRepeatQuestions(["Which plan length works best for you?"], null)).toBe(0);
  });

  it("returns 0 when there are no prior questions", () => {
    expect(countTrailingRepeatQuestions([], "Which plan length works best for you?")).toBe(0);
  });

  it("returns 0 for unrelated consecutive questions", () => {
    const recent = ["What's your shipping address?", "Do you have any allergies?"];
    expect(countTrailingRepeatQuestions(recent, "Would you like the express or standard box?")).toBe(0);
  });

  it("counts a trailing streak of reworded versions of the same question", () => {
    const recent = [
      "Would you like the 3-month plan or the 6-month plan?",
      "Just to confirm, is it the 3-month plan or the 6-month plan you want?",
      "So just the 3-month plan or the 6-month plan?",
    ];
    expect(countTrailingRepeatQuestions(recent, "Should I set you up with the 3-month plan or the 6-month plan?")).toBe(3);
  });

  it("stops counting at the first non-matching question walking backward", () => {
    const recent = [
      "What's your shipping address?",
      "Would you like the 3-month plan or the 6-month plan?",
      "So just the 3-month plan or the 6-month plan?",
    ];
    expect(countTrailingRepeatQuestions(recent, "Should I set you up with the 3-month plan or the 6-month plan?")).toBe(2);
  });

  it("does not treat a real answer that moves the conversation forward as a repeat", () => {
    const recent = ["Would you like the 3-month plan or the 6-month plan?"];
    expect(countTrailingRepeatQuestions(recent, "Got it, 3 months — should I ship it to your home or office?")).toBe(0);
  });

  it("treats a short reworded question as a repeat of a longer one covering the same ground", () => {
    const recent = ["Would you like the 3-month plan or the 6-month plan, whichever works best for your routine?"];
    expect(countTrailingRepeatQuestions(recent, "3-month or 6-month?")).toBe(1);
  });
});

describe("countRepeatQuestionsInHistory", () => {
  const question = "Would you like the 3-month plan or the 6-month plan?";
  const outbound = (body: string) => ({ direction: "outbound", body, sentBy: "ai", deliveryStatus: "sent" });

  it("resets after an answer without another question", () => {
    expect(countRepeatQuestionsInHistory([outbound(question), outbound("Here are the financing details."), outbound(question)], question)).toBe(1);
  });

  it("resets after staff takes over, even if staff asks the same question", () => {
    expect(countRepeatQuestionsInHistory([outbound(question), { ...outbound(question), sentBy: "staff" }], question)).toBe(0);
  });

  it("does not count failed drafts as questions the customer received", () => {
    expect(countRepeatQuestionsInHistory([outbound(question), { ...outbound(question), deliveryStatus: "failed" }], question)).toBe(1);
  });

  it("still catches ignoring customer answers and asking the same question again", () => {
    expect(countRepeatQuestionsInHistory([
      outbound(question), { direction: "inbound", body: "Three months please." },
      outbound(question), { direction: "inbound", body: "I already said three months." },
    ], question)).toBe(2);
  });
});
