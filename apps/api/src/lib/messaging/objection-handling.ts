/**
 * Approved objection-handling scripts for the abandoned-questionnaire outreach
 * workflow. Reviewed and approved by the business owner on 2026-08-15.
 *
 * Each objection follows a fixed three-stage sequence:
 *   Stage 0 → 1 (rebuttal):      one informational statement grounded in an
 *                                 approved knowledge topic, ending in a soft question.
 *   Stage 1 → 2 (secondAttempt): a direct close asking the customer to start
 *                                 the questionnaire now. Still one statement,
 *                                 one question — no re-arguing the same point.
 *   Stage 2 (standDown):         a plain, no-pressure close. No question asked.
 *                                 This is terminal — never a fourth attempt on
 *                                 the same objection in the same session.
 *
 * The reply/nextQuestion split mirrors ClaudeInteractiveResult: reply is the
 * statement, nextQuestion is the separate trailing question (safety.ts
 * validates that a "reply" action always carries exactly one nextQuestion,
 * and that a "pause" action — used for standDown — carries none).
 *
 * requiredTopics lists the knowledge-catalog keys (see knowledge-catalog.ts)
 * that must be declared in knowledgeTopicsUsed for the corresponding text to
 * pass interactivePostCheck's topic-gating.
 *
 * No database imports. No outbound messaging SDK imports.
 */

export type ObjectionKey =
  | "price"
  | "think_about_it"
  | "not_qualified"
  | "is_legit"
  | "no_time"
  | "found_cheaper"
  | "side_effects";

/** Runtime list of the keys above, for building a zod enum / db enum from a single source of truth. */
export const OBJECTION_KEYS = ["price", "think_about_it", "not_qualified", "is_legit", "no_time", "found_cheaper", "side_effects"] as const satisfies readonly ObjectionKey[];

export interface ObjectionStageScript {
  readonly reply: string;
  /** Present for the rebuttal and secondAttempt stages; absent for standDown. */
  readonly nextQuestion?: string;
  readonly requiredTopics: readonly string[];
}

export interface ObjectionScript {
  readonly key: ObjectionKey;
  readonly rebuttal: ObjectionStageScript;
  readonly secondAttempt: ObjectionStageScript;
  readonly standDown: ObjectionStageScript;
}

export const OBJECTION_LIBRARY: readonly ObjectionScript[] = [
  {
    key: "price",
    rebuttal: {
      reply:
        "Totally understand. With $20 off your first month, semaglutide starts at $155 and tirzepatide at $205. That includes provider review, medication, and shipping.",
      nextQuestion: "Want to see the payment plan options?",
      requiredTopics: ["semaglutide_pricing", "tirzepatide_pricing", "first_month_offer"],
    },
    secondAttempt: {
      reply: "No pressure at all.",
      nextQuestion: "Ready to fill out the questionnaire so we can see what applies to you?",
      requiredTopics: [],
    },
    standDown: {
      reply: "No worries, we're here whenever the timing's better.",
      requiredTopics: [],
    },
  },
  {
    key: "think_about_it",
    // Rebuttal is deliberately a question, not a claim — "not ready yet" on
    // its own isn't something to argue with, it's a prompt to find out what
    // it actually means. A concrete answer here ("it's the cost", "I have a
    // question about X") surfaces as its own, different objection at its own
    // stage 0 — see the per-objection stage tracking in provider.ts's
    // buildObjectionSection — so this step doubles as routing, not just
    // stalling for time.
    rebuttal: {
      reply: "Totally fine, no rush.",
      nextQuestion: "Is there anything specific holding you back, or any questions I can help answer?",
      requiredTopics: [],
    },
    secondAttempt: {
      reply: "No worries at all. No obligation until a provider reviews it.",
      nextQuestion: "Want to just get the questionnaire started now?",
      requiredTopics: ["how_ark_works"],
    },
    // Terminal for THIS conversation, but not the end of outreach — reaching
    // stand-down on this specific objection arms a one-time re-engagement
    // text 2 weeks out (see objection-reengagement.service.ts), the same way
    // "no problem" from a real salesperson doesn't mean "never follow up
    // again."
    standDown: {
      reply: "No problem, I'll leave it here for whenever you're ready.",
      requiredTopics: [],
    },
  },
  {
    key: "not_qualified",
    rebuttal: {
      reply: "That's exactly what the questionnaire is for. It takes about 5 minutes, and a licensed provider reviews it to see if you qualify.",
      nextQuestion: "Want to go ahead and check?",
      requiredTopics: ["eligibility_requirements", "how_ark_works"],
    },
    secondAttempt: {
      reply: "No pressure either way.",
      nextQuestion: "Want to go ahead and start the questionnaire so we can find out?",
      requiredTopics: ["eligibility_requirements"],
    },
    standDown: {
      reply: "That's okay, the offer will still be here.",
      requiredTopics: [],
    },
  },
  {
    key: "is_legit",
    rebuttal: {
      reply: "Fair question. We're a licensed telehealth provider, your info is handled under HIPAA, and a real provider reviews everything before anything moves forward.",
      nextQuestion: "Want to see reviews from other customers?",
      requiredTopics: ["privacy_hipaa", "customer_reviews"],
    },
    secondAttempt: {
      reply: "Totally understand the hesitation.",
      nextQuestion: "Ready to go ahead and start the questionnaire?",
      requiredTopics: [],
    },
    standDown: {
      reply: "No problem, happy to answer anything else whenever.",
      requiredTopics: [],
    },
  },
  {
    key: "no_time",
    rebuttal: {
      reply: "Totally get it, it only takes about 5 minutes.",
      nextQuestion: "Want to go ahead and get started now?",
      requiredTopics: ["how_ark_works"],
    },
    secondAttempt: {
      reply: "No rush, it only takes about 5 minutes.",
      nextQuestion: "Want to knock it out real quick?",
      requiredTopics: ["how_ark_works"],
    },
    standDown: {
      reply: "Sounds good, it'll be here when you're ready.",
      requiredTopics: [],
    },
  },
  {
    key: "found_cheaper",
    rebuttal: {
      reply: "Pricing varies a lot between providers. Ours includes the provider review, medication, and shipping with no hidden fees.",
      nextQuestion: "Want to see the full breakdown?",
      requiredTopics: ["semaglutide_pricing", "tirzepatide_pricing", "plan_inclusions"],
    },
    secondAttempt: {
      reply: "Fair enough.",
      nextQuestion: "Want to go ahead and start the questionnaire so you can see exactly what's included?",
      requiredTopics: ["plan_inclusions"],
    },
    standDown: {
      reply: "Totally understand, the offer will still be available.",
      requiredTopics: [],
    },
  },
  {
    key: "side_effects",
    rebuttal: {
      reply:
        "Good question. Both meds can cause side effects early on, and it varies person to person. A provider reviews your health history before anything's approved.",
      nextQuestion: "Want to go over which one you're considering?",
      requiredTopics: ["side_effects"],
    },
    secondAttempt: {
      reply: "That's understandable.",
      nextQuestion: "Want to start the questionnaire so a provider can go over your specific situation?",
      requiredTopics: ["side_effects"],
    },
    standDown: {
      reply: "No worries, reach out whenever you want to talk it through.",
      requiredTopics: [],
    },
  },
] as const;

export function getObjectionScript(key: ObjectionKey): ObjectionScript | undefined {
  return OBJECTION_LIBRARY.find((o) => o.key === key);
}

/**
 * "Are you an AI / a bot?" — a fixed, honest disclosure script.
 *
 * allowedParaphrase is intentionally false: several jurisdictions (e.g.
 * California's B.O.T. Act, Bus. & Prof. Code §17941; the EU AI Act's
 * transparency provisions) require a bot used to influence a purchase to
 * disclose, when directly asked, that it is not a human. This script must be
 * used verbatim — never rewritten to imply Alexis is human. It is not staged;
 * the same disclosure applies every time the question is asked.
 */
export const AI_DISCLOSURE_SCRIPT: ObjectionStageScript & { readonly allowedParaphrase: false } = {
  reply:
    "I'm an automated assistant here with the Ark Health team, and I'm here to help you get started. If you'd rather talk to a person, I can get one looped in.",
  nextQuestion: "Want me to go ahead and get you started on the questionnaire?",
  requiredTopics: [],
  allowedParaphrase: false,
};

/**
 * "I want to talk to a person" — always routes to staff_review. No AI-drafted
 * rebuttal or close is ever generated for this request.
 *
 * TODO(staff-review-workflow): every staff_review handoff must be flagged AND
 * trigger an actual notification (Slack/email/dashboard) to staff — a silent
 * queue entry is not sufficient. Not yet implemented; tracked for when the
 * staff-review workflow (message_ai_suggestions / notification delivery) is built.
 */
export const WANTS_HUMAN_ROUTES_TO_STAFF_REVIEW = true;
