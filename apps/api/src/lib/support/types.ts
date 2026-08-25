/**
 * Types for Sophie's (the post-purchase support bot) structured reply.
 *
 * Deliberately free of SDK imports so this module is safe to import anywhere.
 * The Anthropic SDK must live exclusively in a provider module that is only
 * dynamically imported when all gate conditions pass.
 *
 * No database imports. No outbound messaging SDK imports.
 */

export type SophieAction = "reply" | "pause" | "staff_review" | "no_reply";

export interface SophieInteractiveResult {
  readonly action: SophieAction;
  readonly reply: string | null;
  readonly confidence: number;
  readonly detectedIntents: readonly string[];
  /** Knowledge-catalog topic keys Sophie cited in her response. */
  readonly knowledgeTopicsUsed: readonly string[];
  /** True when Sophie flagged the turn as requiring staff review. */
  readonly requiresStaff: boolean;
  readonly safetyCodes: readonly string[];
  /**
   * The single follow-up question appended to every action=reply message.
   * Must end with "?" and contain exactly one "?". Null for non-reply actions.
   */
  readonly nextQuestion: string | null;
  /**
   * Sentiment of the patient's most recent inbound message, tagged by this
   * same call rather than a separate classification request. Null when there
   * was no inbound message to react to (e.g. a proactive status update).
   */
  readonly inboundSentiment: "positive" | "neutral" | "negative" | null;
}

export interface SophiePreviewMessage {
  readonly direction: "inbound" | "outbound";
  readonly body: string;
}

export interface SophiePreviewRequestBody {
  readonly messages: readonly SophiePreviewMessage[];
  /** Live order-fulfillment facts — injected as ground truth, never guessed. */
  readonly orderState: {
    readonly prescriptionWritten: boolean;
    readonly orderShipped: boolean;
    readonly trackingNumber: string | null;
    readonly paymentFailed: boolean;
  };
  /**
   * True once the post-delivery review check-in has been sent this session —
   * changes Sophie's goal from "answer questions" to "listen for a sentiment
   * on the experience question and react accordingly."
   */
  readonly reviewRequested: boolean;
  readonly lastQuestion: string | null;
  readonly pendingTopic: string | null;
  readonly lastDraft: string | null;
}
