import type { BotPreviewRequestBody, ClaudeInteractiveResult } from "./types.js";

export const CHECKOUT_HELP = "Use the intake link in my earlier message to continue signup and follow the checkout steps for payment. You can open that link without waiting for an email.";
export const PRODUCT_HELP = "Semaglutide is the lower-cost option. Tirzepatide has shown greater average weight loss in clinical studies, though individual results vary. You choose which medication to request for provider review.";

function reply(body: BotPreviewRequestBody, text: string, question: string | null, topic: string, staff = false): ClaudeInteractiveResult {
  return {
    action: staff ? "staff_review" : "reply", reply: text, nextQuestion: question,
    confidence: 1, detectedIntents: [staff ? "clarification_handoff" : "signup_help"],
    detectedIntent: staff ? "clarification_handoff" : "signup_help",
    knowledgeTopicsUsed: [topic], requiresStaff: staff, slotUpdates: {},
    resumeTopic: null, safetyCodes: [], linkProvided: body.linkProvided,
    objectionStage: body.objectionStage, objectionKey: body.objectionKey,
    promoOffered: body.promoOffered, inboundSentiment: null,
    learnedFirstName: null, preferredReengagementDate: null,
  };
}

/** Called only after inbound safety checks. No link minting, email promises, or financing changes. */
export function signupHelp(body: BotPreviewRequestBody, asksForLink: boolean): ClaudeInteractiveResult | null {
  const messages = body.messages;
  let end = messages.length - 1;
  while (end >= 0 && messages[end].direction !== "inbound") end--;
  if (end < 0) return null;
  let start = end;
  while (start > 0 && messages[start - 1].direction === "inbound") start--;
  const inbound = messages.slice(start, end + 1).map(m => m.body).join(" ");
  const previous = messages.slice(0, start).filter(m => m.direction === "outbound").slice(-3).map(m => m.body).join(" ");
  const confused = /\b(?:not sure|unsure|confused|don.t (?:know|understand)|do not (?:know|understand)|don.t get it|what(?:'s| is) the difference|how (?:are|do) they differ|which one|what do you mean)\b/i.test(inbound);

  if (body.linkProvided && !asksForLink) {
    // Do not misroute shipping, receipt, or clinical-email issues into signup help.
    const otherEmail = /\b(?:receipt|shipping|tracking|prescription|lab|refund)\b/i.test(inbound);
    const paymentLocation = /\b(?:where|how|who)\b.{0,35}\b(?:pay|payment|checkout)\b|\bpay\b.{0,20}\b(?:where|who)\b/i.test(inbound);
    const missingEmail = /\b(?:haven.t|have not|didn.t|did not|never|not|no|missing|waiting for)\b.{0,35}\bemail\b|\bwhere(?:'s| is)\b.{0,15}\bemail\b/i.test(inbound);
    const continuedTrouble = previous.includes(CHECKOUT_HELP) &&
      (confused || /^(?:no|nope|it doesn.t work|can.t open it|cannot open it)[.! ]*$/i.test(inbound.trim()));
    if (continuedTrouble || (previous.includes(CHECKOUT_HELP) && (paymentLocation || missingEmail) && !otherEmail)) {
      return reply(body, "I'll ask our team to help you access signup and find the payment step.", null, "how_ark_works", true);
    }
    if (!otherEmail && (paymentLocation || missingEmail)) {
      return reply(body, CHECKOUT_HELP, "Can you open the link in my earlier message?", "how_ark_works");
    }
  }

  return null;
}
