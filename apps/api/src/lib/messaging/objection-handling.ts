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
 *   Stage 2 (standDown):         a plain, no-pressure close. This is terminal —
 *                                 never a fourth attempt on the same objection
 *                                 in the same session. Two objections
 *                                 (think_about_it, no_time) ask when a better
 *                                 time to follow up is instead of a bare close;
 *                                 every other standDown asks nothing.
 *
 * The reply/nextQuestion split mirrors ClaudeInteractiveResult: reply is the
 * statement, nextQuestion is the separate trailing question (safety.ts
 * validates that a "reply" action always carries exactly one nextQuestion,
 * and that a "pause" action — used for a question-less standDown — carries none).
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
  /**
   * Always present for the rebuttal and secondAttempt stages. Present for
   * standDown only on the two objections (think_about_it, no_time) whose
   * stand-down asks when a better time to follow up is instead of just
   * leaving things open-ended — see REENGAGEMENT_TIME_QUESTIONS below and
   * REENGAGEMENT TIMING in provider.ts. Absent for every other objection's
   * standDown, which stays a plain close with no further ask.
   * An array is 2+ approved variants that mean the same thing — the caller
   * (buildObjectionSection in provider.ts) picks one at random per turn, the
   * same reasoning as pickVariant in follow-up-templates.ts: every lead
   * getting the exact same byte-for-byte question reads as templated.
   */
  readonly nextQuestion?: string | readonly string[];
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
        "Totally understand. With $40 off, semaglutide starts at $129 and tirzepatide at $185. That includes provider review, medication, and shipping.",
      nextQuestion: "Want to see the payment plan options?",
      requiredTopics: ["semaglutide_pricing", "tirzepatide_pricing", "first_month_offer"],
    },
    secondAttempt: {
      // Discovery, not another price pitch — repeating or lowering the price
      // a second time reads as haggling against yourself and never
      // surfaces the real gap. Asking what they had in mind either reveals
      // an anchor already at or above what we can offer, or gives something
      // concrete to actually respond to instead of guessing at a number.
      reply: "No pressure at all.",
      nextQuestion: ["What price were you hoping for?", "What are you paying now for something similar?"],
      requiredTopics: [],
    },
    // Terminal for THIS conversation, but not the end of outreach — same as
    // think_about_it's standDown below, reaching stand-down here arms a
    // one-time re-engagement text 2 weeks out (see
    // objection-reengagement.service.ts) — "we're here whenever the timing's
    // better" shouldn't mean the outreach actually stops forever.
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
    // again." Asks when a better time is, rather than passively leaving it
    // open-ended — a real production case (Luma) had a customer stand down
    // with no way to actually tell us when to come back, so the 2-week
    // default was the only thing that ever fired. If they do answer with a
    // time, that reply is used to reschedule the re-engagement text instead
    // of the default — see REENGAGEMENT_TIME_QUESTIONS and provider.ts's
    // preferredReengagementDate handling.
    standDown: {
      reply: "No problem, no rush at all.",
      nextQuestion: "Is there a better time for me to check back in with you?",
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
    // Same reasoning as think_about_it's standDown above — asks when a
    // better time is instead of leaving it open-ended.
    standDown: {
      reply: "No worries at all.",
      nextQuestion: "What's a better time for us to follow up with you?",
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
 * The exact standDown nextQuestion text for the two objections that ask
 * when a better time to follow up is (think_about_it, no_time) — used by
 * provider.ts to recognize, on the customer's NEXT message, that this is
 * their answer to that specific question rather than an answer to
 * something else, so it knows when it's safe to try extracting a
 * preferredReengagementDate from their reply.
 */
export const REENGAGEMENT_TIME_QUESTIONS: readonly string[] = OBJECTION_LIBRARY.filter((o) => o.key === "think_about_it" || o.key === "no_time")
  .map((o) => o.standDown.nextQuestion)
  .filter((q): q is string => typeof q === "string");

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
