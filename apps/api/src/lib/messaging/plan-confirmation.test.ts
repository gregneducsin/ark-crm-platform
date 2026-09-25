import { describe, expect, it } from "vitest";
import { hasPlanConfirmation } from "./plan-confirmation.js";

describe("hasPlanConfirmation", () => {
  it.each(["I want the month-to-month plan", "One month please", "month to month"])("accepts Ark's monthly plan: %s", (text) => {
    expect(hasPlanConfirmation({ messages: [{ direction: "inbound", body: text }], currentSlots: { planLength: null }, lastQuestion: null }, "month_to_month")).toBe(true);
  });
  it("accepts confirmation of Ark's monthly plan", () => {
    expect(hasPlanConfirmation({ messages: [{ direction: "inbound", body: "yes" }], currentSlots: { planLength: null }, lastQuestion: "Would you like the month-to-month plan?" }, "month_to_month")).toBe(true);
  });
  it.each([
    ["I want the 3-month plan", null, true],
    ["Three months please", null, true],
    ["yes", "Would you like the 3-month plan?", true],
    ["yes", "Do you want 1 month or 3 months?", false],
    ["yes", "Want to hear about the process?", false],
    ["whatever you think", "Would you like the 3-month plan?", false],
    ["No, not 3 months", null, false],
    ["How much is 3 months?", null, false],
    ["I am considering 3 months", null, false],
    ["I want 1 month", null, false],
    ["yes, but this sounds like a scam", "Would you like the 3-month plan?", false],
    ["I took it for 3 months", null, false],
    ["I want information about 3 months", null, false],
    ["yes", "Would you like to hear about the 3-month plan?", false],
  ])("requires customer intent: %s", (text, question, expected) => {
    const body = {
      messages: [{ direction: "inbound" as const, body: text }],
      currentSlots: { planLength: null },
      lastQuestion: question,
    };
    expect(hasPlanConfirmation(body, "3_month")).toBe(expected);
  });
});
