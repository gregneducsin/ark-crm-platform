import { deduplicateFollowUp } from "../lib/messaging/deduplicate-follow-up.js";
import { supportPreCheck, supportPostCheck } from "../lib/support/safety.js";
import { callSophieInteractive, SophieProviderError } from "../lib/support/provider.js";
import { getSophieEnabledTopics, APPROVED_PORTAL_URL } from "../lib/messaging/knowledge-catalog.js";
import type { SophiePreviewRequestBody, SophieInteractiveResult } from "../lib/support/types.js";
import { logger } from "../lib/logger.js";

/**
 * Prescription-specific questions receive a patient-portal reply while routing to staff.
 */
const PRESCRIPTION_QUESTION_REPLIES = [
  `For anything about your specific prescription or dose, your patient portal is the best place to check. You can view your prescription details or message the doctor directly there: ${APPROVED_PORTAL_URL}`,
  `Great question, for prescription or dose specifics, log into your patient portal to see your details or message the doctor directly: ${APPROVED_PORTAL_URL}`,
  `That's something your patient portal can help with. Log in to view your prescription or message the doctor directly: ${APPROVED_PORTAL_URL}`,
] as const;

/**
 * Reports of potentially compromised medication refrigeration route to staff. The bot cannot assess medication safety; direct the patient to the portal for help.
 */
const COLD_CHAIN_CONCERN_REPLIES = [
  `That's not something to wait on. Please message your doctor or our support team directly through your patient portal so they can look into it right away: ${APPROVED_PORTAL_URL}`,
  `Let's get that looked at right away. Please message your doctor or support directly through the patient portal: ${APPROVED_PORTAL_URL}`,
  `That's worth flagging directly. Please message your doctor or support through the patient portal so they can address it right away: ${APPROVED_PORTAL_URL}`,
] as const;

/**
 * PAUSE_PRESCRIPTION_REQUEST — a patient asking to pause, hold, or skip
 * their prescription/order. Sophie has no way to actually action this, so
 * she must never say or imply it's been paused — that risks the patient
 * believing a shipment/dose is handled when nothing has changed. She points
 * them to the self-service portal and the conversation routes to staff, the
 * same pattern as PRESCRIPTION_QUESTION/COLD_CHAIN_CONCERN above.
 */
const PAUSE_PRESCRIPTION_REQUEST_REPLIES = [
  `For pausing or skipping an order, your patient portal is the best place to manage that: ${APPROVED_PORTAL_URL}`,
  `You can pause or hold your prescription right from your patient portal: ${APPROVED_PORTAL_URL}`,
  `To pause your prescription, please use your patient portal here: ${APPROVED_PORTAL_URL}`,
] as const;

function pickVariant(variants: readonly string[]): string {
  return variants[Math.floor(Math.random() * variants.length)];
}

export type SophieTurnResult =
  | {
      ok: true;
      action: SophieInteractiveResult["action"];
      reply: string | null;
      nextQuestion: string | null;
      inboundSentiment: "positive" | "neutral" | "negative" | null;
      requiresStaff: boolean;
      knowledgeTopicsUsed: readonly string[];
      source: "pre_check_block" | "model";
      preCheckCode: string | null;
    }
  | { ok: false; code: string };

/** Deterministic replies for pre-check blocks — these never reach Claude. */
const PRE_CHECK_RESULTS: Record<string, { action: "pause" | "staff_review"; reply: string | null }> = {
  OPT_OUT: { action: "pause", reply: "You've been unsubscribed and won't receive further messages. Reply HELP for help." },
  STOP_WORD: { action: "staff_review", reply: null },
  EMERGENCY_CONTENT: {
    action: "staff_review",
    reply:
      "If this is a medical emergency, please call 911 or go to your nearest emergency room right away. This text line isn't monitored for emergencies. Our team has been notified and will follow up with you.",
  },
  // reply: null here is a placeholder — the real reply is picked at send
  // time from PRESCRIPTION_QUESTION_REPLIES / PAUSE_PRESCRIPTION_REQUEST_REPLIES
  // / COLD_CHAIN_CONCERN_REPLIES, see below.
  PRESCRIPTION_QUESTION: { action: "staff_review", reply: null },
  PAUSE_PRESCRIPTION_REQUEST: { action: "staff_review", reply: null },
  COLD_CHAIN_CONCERN: { action: "staff_review", reply: null },
  LEGAL_CONTENT: { action: "staff_review", reply: null },
};

/**
 * Same mechanical-vs-safety retry split as Alexis's conversation loop (see
 * alexis-conversation.service.ts's docstring) — format-only rejections get one
 * retry of the identical prompt; safety-relevant rejections never retry.
 */
const RETRYABLE_POST_CHECK_CODES = new Set(["MISSING_NEXT_QUESTION", "INVALID_NEXT_QUESTION", "UNEXPECTED_NEXT_QUESTION", "QUESTION_MARK_IN_REPLY", "REPEATED_DRAFT"]);
const MAX_ATTEMPTS = 3;

export async function runSophieTurn(body: SophiePreviewRequestBody): Promise<SophieTurnResult> {
  const lastInbound = [...body.messages].reverse().find((m) => m.direction === "inbound");
  if (lastInbound) {
    const pre = supportPreCheck(lastInbound.body);
    if (pre.blocked) {
      const deterministic = PRE_CHECK_RESULTS[pre.code] ?? { action: "staff_review" as const, reply: null };
      const reply =
        pre.code === "PRESCRIPTION_QUESTION"
          ? pickVariant(PRESCRIPTION_QUESTION_REPLIES)
          : pre.code === "PAUSE_PRESCRIPTION_REQUEST"
            ? pickVariant(PAUSE_PRESCRIPTION_REQUEST_REPLIES)
            : pre.code === "COLD_CHAIN_CONCERN"
              ? pickVariant(COLD_CHAIN_CONCERN_REPLIES)
              : deterministic.reply;
      return {
        ok: true,
        action: deterministic.action,
        reply,
        nextQuestion: null,
        inboundSentiment: null,
        requiresStaff: deterministic.action === "staff_review",
        knowledgeTopicsUsed: [],
        source: "pre_check_block",
        preCheckCode: pre.code,
      };
    }
  }

  const enabledTopics = getSophieEnabledTopics();
  const permittedTopicKeys = new Set(enabledTopics.map((t) => t.key));

  let post: ReturnType<typeof supportPostCheck> | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw: SophieInteractiveResult;
    try {
      raw = await callSophieInteractive(body, enabledTopics);
    } catch (err) {
      if (err instanceof SophieProviderError) {
        logger.error({ category: err.category }, "Sophie provider call failed");
        return { ok: false, code: err.category };
      }
      throw err;
    }

    raw = deduplicateFollowUp(raw);
    post = supportPostCheck(raw, body.lastDraft, permittedTopicKeys);
    if (post.ok) break;

    const canRetry = attempt < MAX_ATTEMPTS && RETRYABLE_POST_CHECK_CODES.has(post.code);
    logger.warn({ code: post.code, attempt, retrying: canRetry }, "Sophie reply rejected by post-check");
    if (!canRetry) {
      return { ok: false, code: post.code };
    }
  }

  if (!post?.ok) {
    throw new Error("unreachable: post-check loop exited without an ok result");
  }
  const result = post.result;

  return {
    ok: true,
    action: result.action,
    reply: result.reply,
    nextQuestion: result.nextQuestion,
    inboundSentiment: result.inboundSentiment,
    requiresStaff: result.requiresStaff,
    knowledgeTopicsUsed: result.knowledgeTopicsUsed,
    source: "model",
    preCheckCode: null,
  };
}
