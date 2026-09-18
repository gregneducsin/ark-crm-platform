import { interactivePreCheck, interactivePostCheck } from "../lib/messaging/safety.js";
import { callClaudeInteractive, ProviderError } from "../lib/messaging/provider.js";
import { getPreviewEnabledTopics } from "../lib/messaging/knowledge-catalog.js";
import type { BotPreviewRequestBody, ClaudeInteractiveResult } from "../lib/messaging/types.js";
import type { ObjectionKey } from "../lib/messaging/objection-handling.js";
import { createIntakeLink } from "./intake-links.service.js";
import { logger } from "../lib/logger.js";

export type AlexisTurnResult =
  | {
      ok: true;
      action: ClaudeInteractiveResult["action"];
      reply: string | null;
      nextQuestion: string | null;
      link: string | null;
      objectionStage: 0 | 1 | 2;
      objectionKey: ObjectionKey | null;
      linkProvided: boolean;
      promoOffered: boolean;
      inboundSentiment: "positive" | "neutral" | "negative" | null;
      requiresStaff: boolean;
      knowledgeTopicsUsed: readonly string[];
      validatedSlotUpdates: Record<string, unknown>;
      source: "pre_check_block" | "model";
      preCheckCode: string | null;
      learnedFirstName: string | null;
    }
  | { ok: false; code: string };

/**
 * Deterministic replies for pre-check blocks — these never reach Claude.
 *
 * SUITABILITY_QUESTION and MEDICAL_CONTENT get a real reply, not silence:
 * the honest, always-safe answer to "is this safe for me" / "will you
 * prescribe me a higher dose" is the same regardless of the specific
 * question — it's the doctor's call, made during questionnaire review, not
 * something Alexis is ever positioned to answer. Still routes to staff
 * (action: "staff_review") so a human sees it, but the customer isn't left
 * hanging in the meantime. The actual reply text is picked at random from
 * INDIVIDUALIZED_MEDICAL_REPLIES below (see pickVariant), not fixed here —
 * a customer asking two different individualized questions in the same
 * conversation shouldn't get the exact same sentence back twice.
 *
 * OPT_OUT and EMERGENCY_CONTENT are deliberately NOT varied — compliance
 * and safety-critical instructions (unsubscribe confirmation, "call 911")
 * stay exact and unambiguous every time, not paraphrased for variety.
 */
const INDIVIDUALIZED_MEDICAL_REPLIES = [
  "That's up to the doctor to decide. Complete the questionnaire and they'll review your information to let you know what's approved for you.",
  "Only the doctor can make that call. Complete the questionnaire and they'll go over your info and let you know what's approved.",
  "That one's for the doctor to review. Complete the questionnaire and they'll take a look at your info and confirm what's approved for you.",
] as const;

/**
 * A lead describing an active side effect (nausea, vomiting, diarrhea) on a
 * medication they're currently taking — see SIDE_EFFECT_PHRASES_LOWER's
 * docstring in safety.ts for why this is its own code instead of falling
 * into MEDICAL_CONTENT's generic deflection or, worse, Claude reaching its
 * own "don't discuss symptoms" boundary and going silent.
 *
 * Deliberately names real options (an anti-nausea medication, or adjusting
 * the dose) instead of just deflecting — the lead is asking because they're
 * uncomfortable right now, and "that's up to the doctor" alone doesn't tell
 * them anything is actually fixable. Still frames both as things the doctor
 * reviews/discusses, never as Alexis telling them what to do — nothing here
 * is an instruction to take an OTC medication or change a dose on their own.
 */
const SIDE_EFFECT_REPORT_REPLIES = [
  "Nausea and diarrhea are pretty common when starting semaglutide or tirzepatide, and they often ease up after a few weeks. If it doesn't get better, your doctor can go over options like an anti-nausea medication (such as Zofran) or adjusting your dose once you're set up with us.",
  "That's a common early side effect and it usually settles down over the first few weeks. If it sticks around, your doctor can talk through options like an anti-nausea medication (like Zofran) or lowering your dose to help.",
  "Those symptoms are pretty common when starting out and often ease up after a bit. If they don't, your doctor can discuss options like an anti-nausea medication (Zofran is a common one) or adjusting your dose.",
] as const;

function pickVariant(variants: readonly string[]): string {
  return variants[Math.floor(Math.random() * variants.length)];
}

const PRE_CHECK_RESULTS: Record<string, { action: "pause" | "staff_review"; reply: string | null }> = {
  OPT_OUT: { action: "pause", reply: "You've been unsubscribed and won't receive further messages. Reply HELP for help." },
  STOP_WORD: { action: "staff_review", reply: null },
  EMERGENCY_CONTENT: {
    action: "staff_review",
    reply:
      "If this is a medical emergency, please call 911 or go to your nearest emergency room right away. This text line isn't monitored for emergencies. Our team has been notified and will follow up with you.",
  },
  // reply: null here is a placeholder — the real reply for these three codes
  // is picked at send time from INDIVIDUALIZED_MEDICAL_REPLIES /
  // SIDE_EFFECT_REPORT_REPLIES, see below.
  SUITABILITY_QUESTION: { action: "staff_review", reply: null },
  MEDICAL_CONTENT: { action: "staff_review", reply: null },
  SIDE_EFFECT_REPORT: { action: "staff_review", reply: null },
  LEGAL_CONTENT: { action: "staff_review", reply: null },
};

/**
 * Post-check codes safe to retry: these are mechanical format slips (the
 * question landed in the wrong field, or in two places, or Claude repeated
 * its own last draft), not safety-relevant rejections. Retrying these
 * re-runs the exact same prompt — no "you got it wrong" context is added —
 * since this is plain output variance, not a content problem to correct.
 *
 * UNSUPPORTED_PRICING_CLAIM is the one exception, retried WITH corrective
 * feedback (see RETRY_NOTES below) rather than blindly: a real case in the
 * Luma sibling app had Alexis's Lucy try to quote a price right after the
 * customer picked a product — exactly what she's supposed to do — but
 * forget to cite the pricing topic, get permanently blocked with no second
 * attempt, and sit unanswered until a staff member noticed and typed the
 * same price in by hand. She almost certainly knew the right number; she
 * just missed a citation formality. Blindly retrying (like the other codes)
 * would risk repeating that same mistake, which is exactly why this wasn't
 * retried before — but telling her what specifically went wrong makes a
 * second attempt worth taking here, unlike a genuine content problem
 * (clinical language, an unapproved URL, an actually-wrong price) where a
 * retry has nothing new to go on and still isn't attempted.
 */
const RETRYABLE_POST_CHECK_CODES = new Set([
  "MISSING_NEXT_QUESTION",
  "INVALID_NEXT_QUESTION",
  "UNEXPECTED_NEXT_QUESTION",
  "QUESTION_MARK_IN_REPLY",
  "REPEATED_DRAFT",
  "UNSUPPORTED_PRICING_CLAIM",
]);

/** Corrective feedback injected into a retry — see RETRYABLE_POST_CHECK_CODES' docstring. Codes not listed here retry with no added context, same as before. */
const RETRY_NOTES: Partial<Record<string, string>> = {
  UNSUPPORTED_PRICING_CLAIM:
    "Your last reply mentioned a price or discount but was rejected because it didn't cite an approved pricing knowledge topic (or used a figure that isn't one of the exact approved amounts). If you're quoting a price this turn, make sure to include the correct topic key (e.g. semaglutide_pricing, tirzepatide_pricing, first_month_offer) in knowledgeTopicsUsed, and use only the exact approved figures from that topic's approved text.",
};

const MAX_ATTEMPTS = 3;

/**
 * Run one turn of the Alexis conversation loop: pre-check the inbound message,
 * call Claude if it isn't blocked, post-check the response, and — on
 * action=send_form — mint the actual per-lead signup link (Claude never sees
 * or outputs a real one).
 *
 * Fails closed: any pre-check block or a non-retryable post-check rejection
 * short-circuits before the caller ever gets an unvalidated reply — no
 * automatic repair, no second guess at what Claude "meant." A format-only
 * rejection (see RETRYABLE_POST_CHECK_CODES) gets exactly one retry of the
 * same call before giving up the same way.
 */
export async function runAlexisTurn(personId: string, body: BotPreviewRequestBody): Promise<AlexisTurnResult> {
  const lastInbound = [...body.messages].reverse().find((m) => m.direction === "inbound");
  if (lastInbound) {
    const pre = interactivePreCheck(lastInbound.body, body.lastQuestion);
    if (pre.blocked) {
      const deterministic = PRE_CHECK_RESULTS[pre.code] ?? { action: "staff_review" as const, reply: null };
      const reply =
        pre.code === "SIDE_EFFECT_REPORT"
          ? pickVariant(SIDE_EFFECT_REPORT_REPLIES)
          : pre.code === "SUITABILITY_QUESTION" || pre.code === "MEDICAL_CONTENT"
            ? pickVariant(INDIVIDUALIZED_MEDICAL_REPLIES)
            : deterministic.reply;
      return {
        ok: true,
        action: deterministic.action,
        reply,
        nextQuestion: null,
        link: null,
        objectionStage: body.objectionStage,
        objectionKey: body.objectionKey,
        linkProvided: body.linkProvided,
        promoOffered: body.promoOffered,
        inboundSentiment: null,
        requiresStaff: deterministic.action === "staff_review",
        knowledgeTopicsUsed: [],
        validatedSlotUpdates: {},
        source: "pre_check_block",
        preCheckCode: pre.code,
        learnedFirstName: null,
      };
    }
  }

  const enabledTopics = getPreviewEnabledTopics();
  const permittedTopicKeys = new Set(enabledTopics.map((t) => t.key));

  let post: ReturnType<typeof interactivePostCheck> | undefined;
  let retryNote: string | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw: ClaudeInteractiveResult;
    try {
      raw = await callClaudeInteractive(body, enabledTopics, retryNote);
    } catch (err) {
      if (err instanceof ProviderError) {
        logger.error({ category: err.category }, "Alexis provider call failed");
        return { ok: false, code: err.category };
      }
      throw err;
    }

    post = interactivePostCheck(raw, body.lastDraft, permittedTopicKeys);
    if (post.ok) break;

    const canRetry = attempt < MAX_ATTEMPTS && RETRYABLE_POST_CHECK_CODES.has(post.code);
    logger.warn({ code: post.code, attempt, retrying: canRetry }, "Alexis reply rejected by post-check");
    if (!canRetry) {
      return { ok: false, code: post.code };
    }
    retryNote = RETRY_NOTES[post.code];
  }

  // The loop only falls through to here via `break` on post.ok — every other
  // path returns early — but TS can't see that across the loop, so assert it.
  if (!post?.ok) {
    throw new Error("unreachable: post-check loop exited without an ok result");
  }
  const result = post.result;
  let link: string | null = null;
  let finalReply = result.reply;
  let linkMintFailed = false;

  if (result.action === "send_form") {
    try {
      const minted = await createIntakeLink(personId, result.promoOffered ? "first_month_20" : "none", body.leadSource);
      link = minted.url;
      finalReply = result.reply ? `${result.reply} ${link}` : link;
      // Deterministic, not AI-drafted — same reasoning as the link itself
      // never being something Claude generates: a financing mention is a
      // real claim about a third-party product, not something to leave to
      // per-turn phrasing. Sent every time a real link goes out, not gated
      // on plan size — the conversation doesn't track which specific
      // duration/tier the patient ends up choosing at checkout.
      finalReply = `${finalReply} If a bigger package works better for you, you can use Affirm at checkout to split it into payments.`;
    } catch (err) {
      // Same fail-soft posture as every other trigger/send path in this
      // codebase — a config or DB problem minting the link must not silence
      // the whole turn (the customer texted in ready to sign up; going
      // completely quiet here is worse than every other failure mode this
      // pipeline already guards against). The customer still gets Claude's
      // approved reply text, just without the link, and requiresStaff below
      // flags the conversation for a human to follow up with it manually —
      // same mechanism the caller already uses for needsAttention.
      logger.warn({ personId, reason: err instanceof Error ? err.message : String(err) }, "send_form: failed to mint intake link");
      finalReply = result.reply ?? "Someone from our team will follow up with your signup link shortly.";
      linkMintFailed = true;
    }
  }

  return {
    ok: true,
    action: result.action,
    reply: finalReply,
    nextQuestion: result.nextQuestion,
    link,
    objectionStage: result.objectionStage,
    objectionKey: result.objectionKey,
    linkProvided: link !== null ? true : result.linkProvided,
    promoOffered: result.promoOffered,
    inboundSentiment: result.inboundSentiment,
    requiresStaff: result.requiresStaff || linkMintFailed,
    knowledgeTopicsUsed: result.knowledgeTopicsUsed,
    validatedSlotUpdates: post.validatedSlotUpdates,
    source: "model",
    preCheckCode: null,
    learnedFirstName: result.learnedFirstName,
  };
}
