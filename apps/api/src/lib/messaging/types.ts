/**
 * Types for the Claude interactive bot-preview reply.
 *
 * Deliberately free of SDK imports so this module is safe to import anywhere.
 * The Anthropic SDK must live exclusively in a provider module that is only
 * dynamically imported when all gate conditions pass.
 *
 * No database imports. No outbound messaging SDK imports.
 */

import type { ObjectionKey } from "./objection-handling.js";

export type ClaudeInteractiveAction =
  | "reply"
  | "send_form"
  | "pause"
  | "staff_review"
  | "no_reply"
  // Legacy action names kept for backward compatibility — not used in new prompts.
  | "ask_product"
  | "explain_process"
  | "explain_pricing"
  | "explain_inclusions";

export interface ClaudeInteractiveResult {
  readonly action: ClaudeInteractiveAction;
  readonly reply: string | null;
  readonly confidence: number;
  /** Primary field — all detected intents. */
  readonly detectedIntents: readonly string[];
  /** Legacy alias — first element of detectedIntents, or "unknown". */
  readonly detectedIntent: string;
  /** Knowledge-catalog topic keys Claude cited in its response. */
  readonly knowledgeTopicsUsed: readonly string[];
  /** True when Claude flagged the turn as requiring staff review. */
  readonly requiresStaff: boolean;
  readonly slotUpdates: Record<string, unknown>;
  readonly resumeTopic: string | null;
  readonly safetyCodes: readonly string[];
  /**
   * The single follow-up question Claude appends to every action=reply message.
   * Must end with "?" and contain exactly one "?".
   * Null for action=pause, send_form, staff_review, no_reply.
   */
  readonly nextQuestion: string | null;
  /**
   * True when Claude is providing the approved intake URL in this turn's reply.
   * Set by Claude; the client tracks and forwards on subsequent turns.
   */
  readonly linkProvided: boolean;
  /**
   * Objection-handling stage this reply represents, for the objection (if any)
   * addressed in this turn:
   *   0 — no objection handled yet (informational rebuttal, if any, is the first attempt)
   *   1 — this is the second attempt: a direct close asking the customer to start the form
   *   2 — this is the final stand-down: a graceful close, no further asks
   * Combines with the client-side frame (see BotPreviewRequestBody.objectionStage)
   * to select which stage's script applies to the next matching objection.
   */
  readonly objectionStage: 0 | 1 | 2;
  /**
   * Which objection (if any) this reply's objectionStage applies to — null
   * when no objection is in play this turn. Lets the caller tell a brand-new
   * objection apart from a continuation of the same one: without this, a
   * single shared stage number can't distinguish "still pushing back on
   * price, second attempt" from "now raising a completely different
   * objection" (see BotPreviewRequestBody.objectionKey).
   */
  readonly objectionKey: ObjectionKey | null;
  /**
   * True when Claude used the first_month_offer knowledge topic at any point
   * in this session. Determines which signup link variant gets minted on
   * action=send_form (the $20-off promo URL vs. the plain one) — decided at
   * link-mint time, not guessed later, since the click happens hours after
   * the conversation ends and carries no memory of what was discussed.
   */
  readonly promoOffered: boolean;
  /**
   * Sentiment of the customer's most recent inbound message, tagged by this
   * same call rather than a separate classification request. Null when there
   * was no inbound message to react to (e.g. a proactive opener).
   */
  readonly inboundSentiment: "positive" | "neutral" | "negative" | null;
  /**
   * The patient's first name, set only on the turn where they actually state
   * it in their own message — null every other turn, including once it's
   * already known (the caller persists it once; Claude doesn't need to keep
   * re-reporting it). Never guessed or inferred from anything but the
   * patient directly giving their name.
   */
  readonly learnedFirstName: string | null;
}

export interface BotPreviewMessage {
  readonly direction: "inbound" | "outbound";
  readonly body: string;
}

export interface BotPreviewRequestBody {
  readonly messages: readonly BotPreviewMessage[];
  /**
   * Which script the prompt builder uses. abandoned_cart is the default
   * (a patient already mid-checkout who needs closing); meta_form is cold
   * outreach off a Meta lead-gen form and works state/currentlyTaking/product
   * first — see buildSystemPrompt's leadSource branch.
   */
  readonly leadSource: "abandoned_cart" | "meta_form";
  readonly currentSlots: {
    readonly selectedProduct: string | null;
    readonly currentlyTaking: string | null;
    readonly wantsProcessExplanation: string | null;
    readonly hasTimeForIntake: string | null;
    readonly wantsPlanInclusions: string | null;
    readonly readyForForm: string | null;
    /** Free-text state the patient's in — meta_form only, informational, never gates anything. */
    readonly state: string | null;
  };
  readonly lastQuestion: string | null;
  readonly pendingTopic: string | null;
  readonly lastDraft: string | null;
  /**
   * Highest objection-handling stage already reached for the objection under
   * discussion in this session (see ClaudeInteractiveResult.objectionStage):
   *   0 — no objection has been raised yet, or the last one was a new/different objection
   *   1 — the first informational rebuttal has already been given for this objection;
   *       the next matching pushback should get the stage-2 direct close attempt
   *   2 — the stage-2 close has already been given; the next matching pushback
   *       must get the stage-3 stand-down (a plain close, no further asks)
   */
  readonly objectionStage: 0 | 1 | 2;
  /**
   * Which objection the stage above belongs to — null when none has been
   * raised, or when the last one raised was a different objection than
   * whatever comes up this turn (in which case the prompt treats it as a
   * fresh objection at stage 0, regardless of the number above). See
   * ClaudeInteractiveResult.objectionKey.
   */
  readonly objectionKey: ObjectionKey | null;
  /**
   * True when the approved intake link was already provided in a previous turn.
   * Claude should not repeat the link unless the customer explicitly asks again.
   */
  readonly linkProvided: boolean;
  /** True once the first_month_offer topic has been used at any point this session. */
  readonly promoOffered: boolean;
  /**
   * The patient's first name, if already known (from the customer record —
   * not something Claude has said or guessed). Null means genuinely unknown,
   * distinct from the "Unknown" placeholder a webhook-created customer row
   * gets when no name was ever provided — the caller resolves that
   * placeholder to null before this reaches the prompt builder.
   */
  readonly customerFirstName: string | null;
}
