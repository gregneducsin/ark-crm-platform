import { describe, expect, it } from "vitest";
import { signupHelp, CHECKOUT_HELP, PRODUCT_HELP } from "./signup-help.js";
import { interactivePostCheck } from "./safety.js";
import { getPreviewEnabledTopics } from "./knowledge-catalog.js";
import type { BotPreviewRequestBody } from "./types.js";

const topics = new Set(getPreviewEnabledTopics().map(t => t.key));
function body(text: string, previous: string, linked = false): BotPreviewRequestBody {
  return { messages: [{ direction: "outbound", body: previous }, { direction: "inbound", body: text }],
    linkProvided: linked, currentSlots: { selectedProduct: null }, objectionStage: 0,
    objectionKey: null, promoOffered: false } as unknown as BotPreviewRequestBody;
}
function check(b: BotPreviewRequestBody) {
  const result = signupHelp(b, false);
  if (result) expect(interactivePostCheck(result, null, topics).ok).toBe(true);
  return result;
}
describe("signup help", () => {
  it.each(["Where should I pay to who? I haven't get email yet", "How do I pay?", "I didn't receive the email"])("answers %s after a confirmed link", text => {
    expect(check(body(text, "Here is your intake link.", true))).toMatchObject({
      action: "reply", reply: CHECKOUT_HELP, requiresStaff: false,
    });
  });
  it("handles a payment question followed immediately by a hello", () => {
    const b = body("Where do I pay?", "Here is your intake link.", true);
    expect(check({ ...b, messages: [...b.messages, { direction: "inbound", body: "Hello" }] })?.reply).toBe(CHECKOUT_HELP);
  });
  it("hands persistent checkout trouble to staff", () => {
    expect(check(body("No", CHECKOUT_HELP, true))).toMatchObject({ action: "staff_review", requiresStaff: true, nextQuestion: null });
  });
  it("does not invent a sent link or intercept an explicit resend", () => {
    expect(check(body("Where do I pay?", "Hello"))).toBeNull();
    expect(signupHelp(body("Send the form again", "Here is the form", true), true)).toBeNull();
  });
  it.each(["Where is my shipping email?", "I didn't get my receipt email"])("does not confuse other email issues with signup: %s", text => {
    expect(check(body(text, "Here is your intake link.", true))).toBeNull();
  });
});
