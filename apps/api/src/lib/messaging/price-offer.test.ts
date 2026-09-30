import { describe, expect, it } from "vitest";
import { priceOfferFor, priceConfirmationText, selectedPlan } from "./price-offer.js";
import { interactivePostCheck } from "./safety.js";
import { getPreviewEnabledTopics } from "./knowledge-catalog.js";
import type { BotPreviewRequestBody, ClaudeInteractiveResult } from "./types.js";
const topics = new Set(getPreviewEnabledTopics().map(t => t.key));
describe("Ark offer disclosure", () => {
  it.each(["You don't have to pay anything upfront.", "You'll pay $99 per month.", "Your first charge will be October 1.", "You pay when every shipment goes out."])("rejects invented payment commitments in either field: %s", text => {
    for (const field of ["reply", "nextQuestion"]) {
      const raw = {action:"reply",reply:"You can apply through Affirm.",nextQuestion:"Have you used Affirm?",confidence:1,requiresStaff:false,slotUpdates:{},knowledgeTopicsUsed:["insurance_payment","semaglutide_pricing"], [field]:field === "nextQuestion" ? text.replace(/\.$/, "?") : text} as unknown as ClaudeInteractiveResult;
      expect(interactivePostCheck(raw,null,topics).ok).toBe(false);
    }
  });
  it.each(["semaglutide", "tirzepatide"] as const)("keeps %s prices and discounts valid for every plan", product => {
    for (const plan of ["month_to_month", "3_month", "6_month"] as const) for (const promo of [true, false]) {
      const body = { messages: [], currentSlots: { selectedProduct: product, planLength: plan }, promoOffered: promo } as unknown as BotPreviewRequestBody;
      const offer = priceOfferFor(body, {}, promo)!;
      expect(offer.total).toBe(({ semaglutide: {month_to_month:169,"3_month":270,"6_month":594}, tirzepatide:{month_to_month:225,"3_month":510,"6_month":1035}})[product][plan] - (promo ? 40 : 0));
      const result = { action:"reply", reply:priceConfirmationText(offer), nextQuestion:"Do you have time to get started?", confidence:1, requiresStaff:false, slotUpdates:{}, knowledgeTopicsUsed:[`${product}_pricing`, ...(promo ? ["first_month_offer"] : [])] } as unknown as ClaudeInteractiveResult;
      expect(interactivePostCheck(result, null, topics).ok).toBe(true);
    }
  });
  it("recognizes plan selection but not conditional willingness", () => {
    expect(selectedPlan("I'll take six months")).toBe("6_month");
    expect(selectedPlan("The 3 month plan")).toBe("3_month");
    expect(selectedPlan("I'll take six months if it's cheaper")).toBeNull();
  });
});
