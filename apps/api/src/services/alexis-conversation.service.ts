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
 * Post-check codes safe to retry. Two groups:
 *
 * Format-only slips (MISSING/INVALID/UNEXPECTED_NEXT_QUESTION,
 * QUESTION_MARK_IN_REPLY, REPEATED_DRAFT): the question landed in the wrong
 * field, or in two places, or Claude repeated its own last draft. Purely
 * mechanical, never a safety concern — by the time interactivePostCheck
 * reaches any of these, every content check (URL, clinical language,
 * pricing, templates) has already passed clean, so nothing else could be
 * wrong with the reply. Retried WITH corrective feedback (see RETRY_NOTES)
 * instead of blindly re-running the same prompt — a real production case in
 * the Luma sibling app had QUESTION_MARK_IN_REPLY fail 3 blind retries in a
 * row and sit in total silence, because nothing ever told the model what
 * specifically to fix. If every attempt still fails, the last drafted reply
 * is sent anyway — see NEVER_SILENT_CODES below.
 *
 * UNSUPPORTED_PRICING_CLAIM and PROHIBITED_CLINICAL: genuine citation-gating
 * problems, not pure format, so they're kept separate from the group above.
 * UNSUPPORTED_PRICING_CLAIM: a real production case in the Luma sibling app
 * had the conversation bot try to quote a price right after the customer
 * picked a product — exactly what it's supposed to do — but forget to cite
 * the pricing topic, get permanently blocked with no second attempt, and
 * sit unanswered until a staff member noticed and typed the same price in
 * by hand. It almost certainly knew the right number; it just missed a
 * citation formality. Still fails closed if every retry is exhausted,
 * though — an actually-wrong price is a real content problem, unlike the
 * format-only group, so it's NOT in NEVER_SILENT_CODES. PROHIBITED_CLINICAL:
 * the same citation-gating shape (see TOPIC_SPECIFIC_LANGUAGE in safety.ts),
 * and the same real production case showed the same failure mode: a
 * routine DTC eligibility conversation, answered every question asked of
 * it, then total silence because a gated word landed without its topic.
 * This one IS in NEVER_SILENT_CODES — see that constant's own docstring.
 */
const RETRYABLE_POST_CHECK_CODES = new Set([
  "MISSING_NEXT_QUESTION",
  "INVALID_NEXT_QUESTION",
  "UNEXPECTED_NEXT_QUESTION",
  "QUESTION_MARK_IN_REPLY",
  "REPEATED_DRAFT",
  "UNSUPPORTED_PRICING_CLAIM",
  "PROHIBITED_CLINICAL",
]);

/**
 * Once one of these codes exhausts its retry budget, the last drafted reply
 * is sent anyway (via interactivePostCheck's bypassCodes option, which
 * re-verifies every OTHER check still passes first) rather than falling
 * back to silence or a worse substitute reply. Every code here is purely
 * mechanical — a missing/malformed follow-up question, a question mark in
 * the wrong field, or a repeated draft — never a genuine content problem,
 * so accepting the model's own text carries no real risk. PROHIBITED_CLINICAL
 * is the one exception that isn't pure format (see its own entry in
 * RETRYABLE_POST_CHECK_CODES' docstring) but earns the same treatment: the
 * model is fully capable of answering a plain question, so the fix is to
 * give it every real chance to do so, not substitute a worse, off-topic
 * reply for its own. Its acceptance only ever waives the topic-citation
 * gate itself — never PROHIBITED_CLINICAL_ABSOLUTE (diagnose/contraindicated/
 * symptom language), which has no topic that could ever authorize it and
 * stays hard-blocked no matter how many attempts run out (see the bypass
 * call below, and safety.ts's InteractivePostCheckOptions docstring).
 *
 * UNSUPPORTED_PRICING_CLAIM is deliberately NOT here — a genuinely wrong or
 * unbacked price is a real content problem, not a format one, so it keeps
 * failing closed exactly as before once its retries are exhausted.
 */
const NEVER_SILENT_CODES = new Set([
  "MISSING_NEXT_QUESTION",
  "INVALID_NEXT_QUESTION",
  "UNEXPECTED_NEXT_QUESTION",
  "QUESTION_MARK_IN_REPLY",
  "REPEATED_DRAFT",
  "PROHIBITED_CLINICAL",
]);

/** PROHIBITED_CLINICAL's own, larger attempt budget — see RETRYABLE_POST_CHECK_CODES' docstring. Every other retryable code uses the shared MAX_ATTEMPTS. */
const CLINICAL_MAX_ATTEMPTS = 5;

/** Corrective feedback injected into a retry — see RETRYABLE_POST_CHECK_CODES' docstring. Codes not listed here retry with no added context. */
const RETRY_NOTES: Partial<Record<string, string>> = {
  UNSUPPORTED_PRICING_CLAIM:
    "Your last reply mentioned a price or discount but was rejected because it didn't cite an approved pricing knowledge topic (or used a figure that isn't one of the exact approved amounts). If you're quoting a price this turn, make sure to include the correct topic key (e.g. semaglutide_pricing, tirzepatide_pricing, first_month_offer) in knowledgeTopicsUsed, and use only the exact approved figures from that topic's approved text.",
  PROHIBITED_CLINICAL:
    "Your last reply used a clinical/medical word (e.g. dosing, prescribed, treatment, injection, side effects) without citing the specific knowledge topic that's required alongside it, so it was rejected. If you need that word this turn, cite the matching topic in knowledgeTopicsUsed (e.g. titration for dosing/injection language, previous_prescriptions for prescribed/treatment language about a transfer patient, side_effects or product_comparison for side-effect language) — or rephrase without that word if it isn't actually needed to answer this turn.",
  QUESTION_MARK_IN_REPLY:
    "Your last reply's reply field contained a '?' — the question belongs exclusively in nextQuestion, never in reply. Move any question out of reply and into nextQuestion instead.",
  MISSING_NEXT_QUESTION: "Your last reply's nextQuestion field was empty, but this turn requires one. Include a single follow-up question in nextQuestion — don't fold it into reply instead.",
  INVALID_NEXT_QUESTION:
    "Your last reply's nextQuestion field wasn't a single, well-formed question (it either didn't end in '?' or had more than one '?'). Make nextQuestion exactly one complete question ending in exactly one '?'.",
  UNEXPECTED_NEXT_QUESTION:
    "Your last reply included a nextQuestion, but this turn's action doesn't call for a follow-up question. Set nextQuestion to null this turn.",
  REPEATED_DRAFT: "Your last reply repeated the exact same text as your previous draft to this customer. Say something new this turn instead of repeating it verbatim.",
};

/**
 * ProviderError categories safe to retry — a parsing/validation failure one
 * layer BEFORE the post-check above even runs, or a transient API problem.
 * Same fix as the Luma sibling app: a real production case there had a
 * longer, more detail-heavy answer trip ClaudeInteractiveSchema's
 * validation (SCHEMA_VALIDATION_ERROR, most likely the reply field's
 * length cap), and this category had ZERO retries at all, not even a
 * blind one — worse than every post-check code, which at least got one
 * attempt before this session's earlier fixes.
 *
 * PROVIDER_NOT_CONFIGURED is deliberately excluded: a missing/invalid API
 * key is a real misconfiguration, not a one-off model slip or network
 * hiccup, so every retry would fail identically — there's nothing to gain.
 * Every category here either is a transient API problem (PROVIDER_TIMEOUT,
 * PROVIDER_HTTP_ERROR) or means Claude's own output didn't parse or
 * validate (EMPTY_RESPONSE, NO_JSON_OBJECT, JSON_PARSE_ERROR,
 * SCHEMA_VALIDATION_ERROR) — all worth a fresh attempt.
 *
 * Unlike RETRYABLE_POST_CHECK_CODES, none of these ever gets a
 * NEVER_SILENT_CODES-style last-resort "send it anyway": a post-check
 * rejection always has a full, real raw reply sitting there just waiting
 * on one specific check; these categories mean no valid response ever came
 * back at all (or, for SCHEMA_VALIDATION_ERROR, one that failed validation
 * for reasons too open-ended to safely reconstruct blindly) — there's
 * nothing honest to fall back to, so exhausting these still fails closed.
 */
const PROVIDER_RETRYABLE_CATEGORIES = new Set(["PROVIDER_TIMEOUT", "PROVIDER_HTTP_ERROR", "EMPTY_RESPONSE", "NO_JSON_OBJECT", "JSON_PARSE_ERROR", "SCHEMA_VALIDATION_ERROR"]);

/**
 * Corrective feedback for a retried ProviderError — see
 * PROVIDER_RETRYABLE_CATEGORIES' docstring. SCHEMA_VALIDATION_ERROR isn't
 * listed here: its note is built dynamically from the ZodError's own
 * issues (see ProviderError.issues in provider.ts), naming the exact
 * field(s) that failed rather than a generic reminder. PROVIDER_TIMEOUT and
 * PROVIDER_HTTP_ERROR have no note — there's nothing about the output to
 * correct, just a plain retry of the same request.
 */
const PROVIDER_RETRY_NOTES: Partial<Record<string, string>> = {
  EMPTY_RESPONSE: "Your last response came back empty. Make sure to call the bot_reply tool with your actual reply this turn.",
  NO_JSON_OBJECT: "Your last response didn't call the bot_reply tool at all. You must always respond by calling the bot_reply tool — never plain text.",
  JSON_PARSE_ERROR: "Your last response's tool call wasn't valid, well-formed JSON. Make sure every field is properly formatted.",
};

const MAX_ATTEMPTS = 3;

/**
 * Run one turn of the Alexis conversation loop: pre-check the inbound message,
 * call Claude if it isn't blocked, post-check the response, and — on
 * action=send_form — mint the actual per-lead signup link (Claude never sees
 * or outputs a real one).
 *
 * Fails closed for a genuine content problem: any pre-check block, or a
 * post-check rejection outside RETRYABLE_POST_CHECK_CODES (an unapproved
 * URL, an actually-wrong price, PROHIBITED_CLINICAL_ABSOLUTE), short-circuits
 * before the caller ever gets an unvalidated reply — no automatic repair, no
 * second guess at what Claude "meant." But a code in NEVER_SILENT_CODES
 * (purely mechanical format slips, plus PROHIBITED_CLINICAL's citation
 * gate) never ends in total silence: it's retried with corrective feedback,
 * and if every attempt still fails, the last drafted reply is sent anyway
 * rather than substituted with a worse reply or dropped (see the bypass
 * check below).
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

  const overallMaxAttempts = Math.max(MAX_ATTEMPTS, CLINICAL_MAX_ATTEMPTS);
  let post: ReturnType<typeof interactivePostCheck> | undefined;
  let retryNote: string | undefined;
  let lastResortCode: string | null = null;
  for (let attempt = 1; attempt <= overallMaxAttempts; attempt++) {
    let raw: ClaudeInteractiveResult;
    try {
      raw = await callClaudeInteractive(body, enabledTopics, retryNote);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;

      // PROVIDER_NOT_CONFIGURED (and anything else outside
      // PROVIDER_RETRYABLE_CATEGORIES) is a real misconfiguration or
      // unretryable state — every retry would fail identically, so there's
      // nothing to gain from trying again.
      if (!PROVIDER_RETRYABLE_CATEGORIES.has(err.category)) {
        logger.error({ category: err.category }, "Alexis provider call failed");
        return { ok: false, code: err.category };
      }

      const canRetry = attempt < MAX_ATTEMPTS;
      logger.warn({ category: err.category, attempt, retrying: canRetry }, "Alexis provider call failed");
      if (!canRetry) {
        // No valid raw output ever came back for these categories — unlike
        // a post-check rejection, there's genuinely nothing to fall back to
        // and send anyway, so this is the one place that still fails closed
        // even under the never-total-silence philosophy above.
        return { ok: false, code: err.category };
      }
      retryNote =
        err.category === "SCHEMA_VALIDATION_ERROR" && err.issues
          ? `Your last response's bot_reply tool call was rejected for not matching the required format: ${err.issues}. Fix these specific field(s) this turn.`
          : PROVIDER_RETRY_NOTES[err.category];
      continue;
    }

    post = interactivePostCheck(raw, body.lastDraft, permittedTopicKeys);
    if (post.ok) break;

    const codeMaxAttempts = post.code === "PROHIBITED_CLINICAL" ? CLINICAL_MAX_ATTEMPTS : MAX_ATTEMPTS;
    const canRetry = attempt < codeMaxAttempts && RETRYABLE_POST_CHECK_CODES.has(post.code);
    logger.warn({ code: post.code, attempt, retrying: canRetry }, "Alexis reply rejected by post-check");
    if (!canRetry) {
      // Every real attempt still hit the same rejection — before giving up,
      // check whether THAT ONE check is the only thing wrong with this exact
      // reply (waiving just this one code — see interactivePostCheck's
      // bypassCodes option). If nothing else objects, accept it: the
      // model's own reply is better than a worse substitute or silence, and
      // requiresStaff below still routes this to a person. Only codes in
      // NEVER_SILENT_CODES ever get this waiver — everything else (including
      // PROHIBITED_CLINICAL_ABSOLUTE, which interactivePostCheck won't skip
      // regardless of what's passed here) still fails closed exactly as
      // before.
      if (NEVER_SILENT_CODES.has(post.code)) {
        const bypass = interactivePostCheck(raw, body.lastDraft, permittedTopicKeys, { bypassCodes: new Set([post.code]) });
        if (bypass.ok) {
          lastResortCode = post.code;
          post = { ok: true, result: { ...bypass.result, requiresStaff: true }, validatedSlotUpdates: bypass.validatedSlotUpdates };
          break;
        }
        // Something else is also wrong with this reply (e.g. an unapproved
        // URL) — that's a real, different rejection, not something waiving
        // one specific code can fix, so fail closed with THAT code instead.
        return { ok: false, code: bypass.code };
      }
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
    preCheckCode: lastResortCode,
    learnedFirstName: result.learnedFirstName,
  };
}
