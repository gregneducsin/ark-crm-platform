import { describe, expect, it } from "vitest";
import { applyAffirmFlow, AFFIRM_QUESTION, AFFIRM_APPROVAL } from "./affirm-flow.js";
import { interactivePostCheck } from "./safety.js";
import { getPreviewEnabledTopics } from "./knowledge-catalog.js";
import type { BotPreviewRequestBody, ClaudeInteractiveResult } from "./types.js";

const topics = new Set(getPreviewEnabledTopics().map(t => t.key));
function run(text: string, previous = AFFIRM_QUESTION) {
  const body = { messages: [{ direction: "outbound", body: previous }, { direction: "inbound", body: text }],
    currentSlots: { selectedProduct: "semaglutide", planLength: "6_month" }, promoOffered: false,
    linkProvided: false,
  } as unknown as BotPreviewRequestBody;
  const raw = { action: "send_form", reply: "Here is the form.", confidence: 1,
    requiresStaff: false, slotUpdates: {}, knowledgeTopicsUsed: [], nextQuestion: null,
  } as unknown as ClaudeInteractiveResult;
  const result = applyAffirmFlow(body, raw);
  expect(interactivePostCheck(result, null, topics).ok).toBe(true);
  return result;
}
describe("Affirm concern-aware fallback", () => {
  it("acknowledges a plan selection with delayed payment and asks familiarity", () => {
    const result = run("I will go with a 6-month plan but I will not be able to pay for it till the 1st of October", "Does that price work for you?");
    expect(result.nextQuestion).toBe(AFFIRM_QUESTION);
    expect(result.reply).toContain("need to wait before paying");
    expect(result.reply).not.toContain("first charge");
  });
  it("acknowledges timing while moving a familiar customer to intake", () => {
    expect(run("Yes but I cannot pay until October 1st")).toMatchObject({ action: "send_form", nextQuestion: null });
    expect(run("Yes but I cannot pay until October 1st").reply).toContain("need to wait");
  });
  it("responds to the price concern rather than explaining Affirm again", () => {
    const result = run("That is too expensive");
    expect(result.action).toBe("reply");
    expect(result.reply).toContain("total cost is a concern");
    expect(result.nextQuestion).toContain("shorter plan");
  });
  it("respects refusal after the explanation", () => {
    expect(run("No thanks", AFFIRM_APPROVAL)).toMatchObject({ action: "pause", nextQuestion: null });
  });
  it("asks what remains unclear instead of recycling the explanation", () => {
    expect(run("I'm not sure what that means").nextQuestion).toBe(AFFIRM_APPROVAL);
  });
});

describe("intake readiness without a checkout commitment", () => {
  it.each(["I really want start now", "I want to get started", "Send me the form"])("advances %s rather than repeating the price question", text => {
    expect(run(text, AFFIRM_APPROVAL)).toMatchObject({ action: "send_form", nextQuestion: null });
  });
  it("advances a plan selection without explicit total acceptance", () => {
    expect(run("I'll take six months", "Does that price work for you?")).toMatchObject({ action: "send_form", nextQuestion: null });
  });
  it("explains unfamiliar Affirm wording without guaranteeing approval", () => {
    const result = run("Not sure how I do this?");
    expect(result).toMatchObject({ action: "reply", nextQuestion: AFFIRM_APPROVAL });
    expect(result.reply).toBe("You can apply to split the total into payments with Affirm at checkout.");
    expect(result.reply).not.toContain("they approve you");
  });
  it.each(["Only if I'm approved", "If it's cheaper", "I want to start but it is too expensive"])("does not treat %s as unconditional readiness", text => {
    expect(run(text, AFFIRM_APPROVAL).action).not.toBe("send_form");
  });
});
