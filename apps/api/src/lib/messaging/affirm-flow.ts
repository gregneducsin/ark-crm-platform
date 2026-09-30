import { paymentTimingParts } from "./payment-timing.js";
import type { BotPreviewRequestBody, ClaudeInteractiveResult } from "./types.js";
import { priceOfferFor, priceConfirmationText, selectedPlan } from "./price-offer.js";

export const AFFIRM_QUESTION = "Have you used Affirm before, or are you familiar with how it works?";
export const AFFIRM_EXPLANATION = "You can apply to split the total into payments with Affirm at checkout.";
export const AFFIRM_APPROVAL = "Would you like to proceed with the intake form and review Affirm's options at checkout?";

function positive(text: string) {
  return /^(yes|yep|yeah|sure|ok|okay|i have|i am|i'm familiar|yes i have|yes i am|sounds good|let's do it)[.! ]*$/i.test(text.trim());
}

/** Advance intake readiness without treating it as purchase or financing consent. */
export function applyAffirmFlow(body: BotPreviewRequestBody, raw: ClaudeInteractiveResult): ClaudeInteractiveResult {
  if (body.linkProvided || raw.requiresStaff || !["reply", "send_form"].includes(raw.action)) return raw;
  const lastInboundIndex = body.messages.reduce((last, m, index) => m.direction === "inbound" ? index : last, -1);
  if (lastInboundIndex < 0) return raw;
  let firstInboundIndex = lastInboundIndex;
  while (firstInboundIndex > 0 && body.messages[firstInboundIndex - 1].direction === "inbound") firstInboundIndex--;
  const inbound = body.messages.slice(firstInboundIndex, lastInboundIndex + 1).map(m => m.body).join(" ").replace(/’/g, "'");
  const timing = paymentTimingParts(inbound);
  let previous = "";
  let preceding = lastInboundIndex - 1;
  while (preceding >= 0 && body.messages[preceding].direction === "inbound") preceding--;
  for (let i = preceding; i >= 0 && body.messages[i].direction === "outbound"; i--) {
    previous = body.messages[i].body + " " + previous;
  }
  const familiarity = /have you used affirm|familiar with (?:affirm|how it works)/i.test(previous);
  const approval = previous.includes(AFFIRM_APPROVAL) ||
    /(?:proceed|move forward|get started).{0,35}(?:form|intake)|(?:form|intake).{0,35}(?:work for you|okay|ok)/i.test(previous);
  const wantsToStart = /^(?:yes[,.!]?\s*)?(?:i\s+)?(?:really\s+)?(?:want\s+(?:to\s+)?(?:get\s+)?start(?:ed)?|(?:am|'m)\s+ready(?:\s+to\s+(?:start|get started))?|let'?s\s+(?:start|get started)|send\s+(?:me\s+)?(?:the\s+)?form)(?:\s+now|\s+please)?[.! ]*$/i.test(inbound.trim());
  const chosenPlan = selectedPlan(inbound);
  const choosesPlan = chosenPlan !== null && !timing;
  if (chosenPlan) raw = { ...raw, slotUpdates: { ...raw.slotUpdates, planLength: chosenPlan } };
  const asksFinancing = /\baffirm\b|\b(?:split|spread)\b.{0,35}\b(?:payment|cost|total)\b|\b(?:pay|paying)\b.{0,25}\b(?:monthly|a month|upfront|up front)\b/i.test(inbound);
  const offer = priceOfferFor(body, raw.slotUpdates, body.promoOffered || raw.promoOffered);
  if (!offer) return raw;
  const topics = [...new Set([...raw.knowledgeTopicsUsed, "insurance_payment", `${offer.product}_pricing`, ...(offer.discounted ? ["first_month_offer"] : [])])];
  const reply = (text: string, question: string): ClaudeInteractiveResult => ({
    ...raw, action: "reply", reply: text, nextQuestion: question, knowledgeTopicsUsed: topics,
    slotUpdates: { ...raw.slotUpdates, readyForForm: "no" },
  });
  const priceConcern = /\b(?:too expensive|cheaper|can't afford|cannot afford|too much)\b/i.test(inbound) ||
    /\b(?:price|cost|total|amount)\b.{0,25}\b(?:too high|wrong|not okay|not ok)\b/i.test(inbound);
  if (priceConcern) {
    return reply("I understand the total cost is a concern. Affirm changes how payments may be split, not the plan's total price.",
      offer.plan === "month_to_month" ? "Would you like to talk through the available options?" : "Would you like to compare a shorter plan with a lower total?");
  }
  if (/\b(?:only if|if (?:i(?:'m| am)|it(?:'s| is)|approved))\b/i.test(inbound)) {
    return reply("Affirm decides financing approval. Applying does not change the plan total.", "Would you like help understanding the payment options before continuing?");
  }
  if (approval && /^(?:no|nope|not now|no thanks|no thank you)[.! ]*$/i.test(inbound.trim())) {
    return { ...raw, action: "pause", reply: "No problem, we can pause here.", nextQuestion: null,
      slotUpdates: { ...raw.slotUpdates, readyForForm: "no" } };
  }
  if (((familiarity || approval) && positive(timing?.acceptance || inbound)) || wantsToStart || (!familiarity && !approval && choosesPlan)) {
    return { ...raw, action: "send_form", reply: timing
        ? "I understand you need to wait before paying. Here's the intake form."
        : "Here's the intake form.",
      nextQuestion: null, knowledgeTopicsUsed: topics, slotUpdates: { ...raw.slotUpdates, readyForForm: "yes" } };
  }
  if (timing) {
    return reply("I understand you need to wait before paying. " + AFFIRM_EXPLANATION,
      familiarity || approval ? AFFIRM_APPROVAL : AFFIRM_QUESTION);
  }
  if (familiarity && /^(no|nope|not yet|never|i haven't|i have not|not familiar)[.! ]*$/i.test(inbound.trim()) || familiarity && /(?:not sure|don.t know|do not know|how (?:do|would|can) i|how (?:does|do) (?:it|this|affirm)|how i do this)/i.test(inbound)) {
    return reply(AFFIRM_EXPLANATION, AFFIRM_APPROVAL);
  }
  if (asksFinancing && !familiarity && !approval) {
    return reply(`${priceConfirmationText(offer)} ${AFFIRM_EXPLANATION}`, AFFIRM_QUESTION);
  }
  // Prevent a model from skipping explanation/approval on a negative or ambiguous answer.
  if ((familiarity || approval) && raw.action === "send_form") {
    return reply("I want to make sure your question is answered before we continue.",
      "What would you like clarified about Affirm or the plan?");
  }
  return raw;
}
