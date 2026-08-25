/**
 * Pre- and post-Claude safety rules for the interactive bot-preview reply.
 *
 * Pre-check: STOP, emergency, medical, legal, and suitability content
 * short-circuits the provider and returns a deterministic result.
 *
 * Post-check: validates the structured provider response and rejects replies
 * containing unapproved URLs, clinical language, unsupported pricing claims,
 * staff availability promises, disallowed template variables, repeated drafts,
 * invalid slot updates, unsupported knowledge-topic references, malformed
 * nextQuestion fields, or reply-order violations.
 *
 * Mandatory reply-order rule (action=reply):
 *   Every visible reply must follow STATEMENT → QUESTION order.
 *   The question must be the final sentence, `nextQuestion` must exactly equal
 *   that final sentence, and no preceding sentence may contain a "?".
 *
 * No database imports. No outbound messaging SDK imports.
 */

import { z } from "zod";
import type { ClaudeInteractiveResult } from "./types.js";
import { APPROVED_REVIEW_URLS, APPROVED_PRICING_TOPIC_KEYS, PRODUCT_PRICING_TOPIC_KEYS } from "./knowledge-catalog.js";
import { OBJECTION_KEYS } from "./objection-handling.js";
import { stripEmDashes } from "../text-sanitize.js";

// ── Zod schema for structured provider output ─────────────────────────────────

export const ClaudeInteractiveSchema = z
  .object({
    action: z.enum([
      "reply",
      "send_form",
      "pause",
      "staff_review",
      "no_reply",
      // Legacy action names — accepted for backward compatibility.
      "ask_product",
      "explain_process",
      "explain_pricing",
      "explain_inclusions",
    ]),
    reply: z.string().max(400).nullable(),
    confidence: z.number().min(0).max(1),
    /** Primary field — list of detected intents. */
    detectedIntents: z.array(z.string().max(100)).optional().default([]),
    /** Legacy single-intent field — kept for backward compat. */
    detectedIntent: z.string().max(100).optional().default("unknown"),
    /** Knowledge-catalog keys cited in this response. */
    knowledgeTopicsUsed: z.array(z.string().max(100)).optional().default([]),
    /** True when Claude itself flags the turn as requiring staff escalation. */
    requiresStaff: z.boolean().optional().default(false),
    slotUpdates: z.record(z.string(), z.unknown()).optional().default({}),
    resumeTopic: z.string().nullable().optional().default(null),
    safetyCodes: z.array(z.string()).optional().default([]),
    /**
     * The single follow-up question appended to every action=reply message.
     * Required for reply-type actions; must be null for non-reply actions.
     */
    nextQuestion: z.string().max(300).nullable().optional().default(null),
    /**
     * True when Claude is providing the approved intake URL in this reply.
     * The client persists this so Claude is not asked to repeat the link.
     */
    linkProvided: z.boolean().optional().default(false),
    /**
     * Objection-handling stage this reply represents (0, 1, or 2). Combined
     * with the client-side frame to select the next stage's script — see
     * ClaudeInteractiveResult.objectionStage in types.ts for the stage meanings.
     */
    objectionStage: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional().default(0),
    /** Which objection objectionStage belongs to — null when none is in play this turn. See ClaudeInteractiveResult.objectionKey in types.ts. */
    objectionKey: z.enum(OBJECTION_KEYS).nullable().optional().default(null),
    /** True once the first_month_offer topic has been used at any point this session. */
    promoOffered: z.boolean().optional().default(false),
    /** Sentiment of the customer's most recent inbound message. Null with no inbound to react to. */
    inboundSentiment: z.enum(["positive", "neutral", "negative"]).nullable().optional().default(null),
    /** The patient's first name, set only on the turn where they state it themselves. */
    learnedFirstName: z.string().trim().min(1).max(60).nullable().optional().default(null),
  })
  .superRefine((data, ctx) => {
    // Actions that require a non-empty reply
    const needsReply = ["reply", "pause", "send_form", "ask_product", "explain_process", "explain_pricing", "explain_inclusions"].includes(
      data.action,
    );

    if (needsReply && !data.reply) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `reply must be a non-empty string for action: ${data.action}`,
        path: ["reply"],
      });
    }

    // Actions that require reply=null
    const mustBeNull = ["staff_review", "no_reply"].includes(data.action);
    if (mustBeNull && data.reply !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `reply must be null for action: ${data.action}`,
        path: ["reply"],
      });
    }
  });

// ── Pre-check keyword lists ───────────────────────────────────────────────────

/**
 * Single-word opt-out tokens (matched as whole tokens in the upper-cased message).
 * Checked before STOP_WORDS_UPPER. All produce code "OPT_OUT".
 */
const OPT_OUT_WORDS_UPPER = ["STOP", "UNSUBSCRIBE"] as const;

/**
 * Phrase-based opt-out markers (substring match in the lower-cased message).
 * All produce code "OPT_OUT". Checked after OPT_OUT_WORDS_UPPER.
 */
const OPT_OUT_PHRASES_LOWER = [
  "don't contact me",
  "do not contact me",
  "don't text me",
  "do not text me",
  "leave me alone",
  "remove me from your list",
  "take me off your list",
  "stop contacting me",
] as const;

/**
 * Other stop-word tokens that trigger STOP_WORD (→ staff_review, not opt_out).
 *
 * "CANCEL" is intentionally excluded. As a bare word-boundary token it
 * fires on policy questions like "can i cancel it whenever?" — producing a
 * false opt-out. Standalone "CANCEL" opt-out commands should be handled by a
 * client-side simulator's CANCEL_COMMAND_RE which requires the message to
 * be just "cancel" or to explicitly reference subscription / service cancellation.
 */
const STOP_WORDS_UPPER = ["END", "QUIT"] as const;

const EMERGENCY_WORDS_LOWER = ["emergency", "crisis", "suicide", "self-harm", "self harm"] as const;

/**
 * "911" as a standalone token — split out from EMERGENCY_WORDS_LOWER because a
 * plain substring check matches inside any digit string that happens to
 * contain it: an order number ("78911"), a zip code, or a phone number all
 * false-positived into a full emergency escalation. \b anchors don't work
 * between two digits (both are word characters), so this checks that "911"
 * is not immediately adjacent to another digit on either side.
 */
const EMERGENCY_911_RE = /(?<!\d)911(?!\d)/;

/**
 * A lead describing an active side effect on a medication they're currently
 * taking (nausea, vomiting, diarrhea, stomach upset) — checked before
 * MEDICAL_WORDS_LOWER, same reasoning as SUITABILITY_PHRASES_LOWER, so this
 * gets its own SIDE_EFFECT_REPORT code and dedicated reply (real options —
 * an anti-nausea medication or adjusting the dose — for the doctor to
 * discuss) instead of either the generic MEDICAL_CONTENT deflection or,
 * worse, Claude reaching the "don't discuss symptoms" boundary in its own
 * system prompt and silently discarding its reply with nothing sent back
 * (a real production case: a lead described GI symptoms and got total
 * silence for 28 minutes until a staff member manually replied).
 */
const SIDE_EFFECT_PHRASES_LOWER = [
  "nausea",
  "nauseous",
  "throw up",
  "throwing up",
  "vomit",
  "diarrhea",
  "stomach hurt",
  "stomach ache",
  "stomach pain",
  "upset stomach",
  "makes me sick",
  "feel sick",
  "feeling sick",
] as const;

const MEDICAL_WORDS_LOWER = [
  "symptom",
  "diagnosis",
  "diagnose",
  "treatment",
  "prescription",
  "prescribe",
  "medication",
  // "side effect" / "side-effect" intentionally omitted here.
  // General "what are the side effects?" questions are handled by the
  // TOPIC_GATED post-check rule (requires side_effects, weight_loss_expectations,
  // or product_comparison topic). Blocking at pre-check prevented Claude
  // from giving approved educational answers.
  //
  // "dosage" / "dosing" intentionally omitted here too, same reasoning:
  // TOPIC_SPECIFIC_LANGUAGE in the post-check section below already requires
  // the titration topic to be cited before Claude's own reply may use either
  // word — titration's approved text is the exact dosing protocol (the real
  // mg-by-mg progression schedule) plus a standing instruction never to tell
  // a customer to independently change their dose. That's the real guardrail
  // for dosing content; blocking it here just stopped a general "how does
  // dosing work?" from ever reaching it. A genuinely individualized dosing
  // request ("what dose should I take", "should I increase my dose") is
  // still caught separately by SUITABILITY_PHRASES_LOWER below, checked
  // with higher priority than this list either way.
] as const;

const LEGAL_WORDS_LOWER = ["attorney", "lawyer", "lawsuit", "litigation", "legal action"] as const;
/**
 * "sue"/"sues"/"sued"/"suing" as a standalone word — split out from
 * LEGAL_WORDS_LOWER because a plain substring check can't get this right in
 * either direction: "sue" alone matches inside "issue"/"pursue"/"ensue", but
 * padding it as "sue " / "sue," / " suing" (the previous approach) missed a
 * message that ends in "sue" with no trailing space ("I'm going to sue") or
 * ends in punctuation ("I will sue.", "sue!", "sue?") — while still
 * false-positiving on "pursue this" (contains the literal substring "sue ").
 * \b anchors correctly at start/end of string and at punctuation, so this
 * gets both directions right at once.
 */
const LEGAL_SUE_RE = /\bsu(?:e|es|ed|ing)\b/i;

/**
 * Plain shipping/delivery-timing questions — these contain "medication" or
 * "prescription" (both in MEDICAL_WORDS_LOWER) but are asking when a package
 * arrives, not for clinical judgment. Checked with priority before
 * MEDICAL_WORDS_LOWER, same reasoning as SUITABILITY_PHRASES_LOWER below:
 * without this, "how long will it take to get my medication" was blocked at
 * pre-check and routed to staff review even though shipping_delivery is an
 * approved, pre-vetted knowledge topic that answers exactly this question —
 * Claude never got the chance to use it. Deliberately narrow (get/receive/
 * arrive/ship verbs only) so it doesn't also catch a drug-efficacy-onset
 * question like "how long until my medication starts working" — that stays
 * blocked here on purpose: medication_onset_timeline is a Sophie-only topic
 * (an existing-patient question, not a lead's), so Alexis has no approved
 * answer to hand it to and should keep routing it to staff.
 */
const SHIPPING_TIMING_PHRASES_LOWER = [
  "how long will it take to get my",
  "how long until i get my",
  "how long does it take to get my",
  "how long will it take to receive my",
  "how long to receive my",
  "how long until my medication arrives",
  "how long until my medication ships",
  "how long until my order arrives",
  "how long until my order ships",
  "how long until my prescription arrives",
  "how long until my prescription ships",
  "when will my medication arrive",
  "when will my medication ship",
  "when will my order arrive",
  "when will my order ship",
  "when will my prescription arrive",
  "when will my prescription ship",
  "when is my medication arriving",
  "when is my order arriving",
  "how long does shipping take",
  "how long does delivery take",
  // "When will/do I get/receive my prescription/medication/order" — the same
  // shipping-question shape as the "how long ... to get my" phrases above,
  // just asked with "when" instead of "how long." Same narrow "I get/receive
  // my" framing (not "my medication starts working") so an efficacy/onset
  // question stays routed to MEDICAL_CONTENT as before — see the file-level
  // reasoning above about medication_onset_timeline being Sophie-only.
  "when will i get my",
  "when do i get my",
  "when am i getting my",
  "when will i receive my",
  "when do i receive my",
] as const;

/**
 * Plain "how does the process work" questions — these contain "prescription"
 * or "treatment" (both in MEDICAL_WORDS_LOWER) but are asking about the
 * enrollment/fulfillment flow, not for clinical judgment. Checked with the
 * same priority as SHIPPING_TIMING_PHRASES_LOWER above and for the same
 * reason: how_ark_works's own approved text already says "the prescription
 * request is processed..." and "the prescription proceeds through the
 * program," and product_comparison's already says "we offer two weight-loss
 * treatment options" — both words are already freely used in Alexis's own
 * approved content, so blocking a customer for merely asking about either
 * word prevented Claude from using content it was already allowed to give.
 * Deliberately narrow (process/options framing only) so a genuinely
 * individualized question like "is this treatment safe for my heart
 * condition" or "will you prescribe me a higher dose" still gets blocked.
 */
const PROCESS_QUESTION_PHRASES_LOWER = [
  "do i need a prescription",
  "will i need a prescription",
  "how do i get a prescription",
  "how do i get my prescription",
  "how does the prescription process work",
  "how does the prescription work",
  "what's the prescription process",
  "what is the prescription process",
  // "How long does the prescription take" — how long the REVIEW/APPROVAL
  // process takes, same "process" framing as the phrases above, just asked
  // as a duration instead of a mechanism. Deliberately still narrow (needs
  // "prescription"/"approval"/"approved" — not a bare "how long does it
  // take") so a real treatment-duration question ("how long do I need to
  // take this") still falls through to MEDICAL_CONTENT below.
  "how long does the prescription take",
  "how long does prescription take",
  "how long does it take to get a prescription",
  "how long does it take to get prescribed",
  "how long does it take to get approved",
  "how long until i get prescribed",
  "how long until i'm approved",
  "how long until i am approved",
  "how long does approval take",
  "how long does the approval take",
  "how long does the approval process take",
  "what treatment options",
  "which treatment options",
  "how does treatment work",
  "how does the treatment process work",
  "what's the treatment process",
  "what is the treatment process",
] as const;

/**
 * Phrases that indicate a request for individualized clinical suitability
 * judgment. These must never reach the provider — route to staff review.
 */
const SUITABILITY_PHRASES_LOWER = [
  // Substring markers — any message containing these is an individualized request.
  // Using short markers (e.g. "better for me") instead of only full phrases catches
  // contraction forms like "which one's better for me?" (where "one's" ≠ "one is").
  "better for me",
  "right for me",
  "suitable for me",
  // Full-phrase entries for cases where the short marker would be too broad
  "which is better for me",
  "which one is better for me",
  "which medication is better for me",
  "which is right for me",
  "which one is right for me",
  "which medication is right for me",
  "which one should i take",
  "which should i take",
  "which should i use",
  "which one should i use",
  "which would be better for me",
  "am i a good candidate",
  "am i eligible for",
  "would i qualify",
  "is it safe for me to",
  "which one should i get",
  "which do i need",
  "what should i take",
  // Contextual personalization markers
  "my history",
  "my condition",
  "my medical condition", // catches "is this safe with my medical condition?"
  "my situation",
  "recommend for me",
  // Individualized dosing / action requests
  // Note: "should i take" also catches "which one should i take?" but that is
  // already in the list above; the short form captures additional phrasings
  // like "what dose should i take?" without listing every variant separately.
  "should i take",
  "should i increase",
  "should i switch",
  "should i start taking",
  "increase my dose",
  "increase the dose",
] as const;

export type InteractivePreCheckResult = { readonly blocked: false } | { readonly blocked: true; readonly code: string };

/**
 * Check the last inbound message for content that must never reach the
 * provider. Returns the block code or { blocked: false }.
 *
 * Priority order: opt_out > STOP_WORD > emergency > suitability > side effect report > shipping timing > process questions > medical > legal.
 *
 * Opt-out (code "OPT_OUT") takes the highest priority and is terminal —
 * no objection handling, no rebuttal, no provider call.
 *
 * `ourLastQuestion` (optional) is whatever Alexis herself last asked, if
 * anything — see the MEDICAL_WORDS_LOWER check below for the one place it's
 * used: telling apart an unprompted medical statement from a short reply
 * that's just naming which of our own topics the customer wants.
 */
export function interactivePreCheck(lastInbound: string, ourLastQuestion: string | null = null): InteractivePreCheckResult {
  const upper = lastInbound.toUpperCase();
  const lower = lastInbound.toLowerCase();
  const tokens = upper.split(/\W+/);

  // Opt-out — highest priority; returns terminal OPT_OUT code.
  if (OPT_OUT_WORDS_UPPER.some((w) => tokens.includes(w))) {
    return { blocked: true, code: "OPT_OUT" };
  }
  if (OPT_OUT_PHRASES_LOWER.some((w) => lower.includes(w))) {
    return { blocked: true, code: "OPT_OUT" };
  }

  // "END" is a common English word ("when does this end?", "does the plan
  // ever end?") that isn't an opt-out signal when it's the tail of a
  // question about something else. A genuine stop request ("END", "please
  // end this", "I quit") is phrased as a statement/command, never as a
  // question — so a message ending in "?" is excluded from this check.
  // OPT_OUT (STOP/UNSUBSCRIBE, checked above) is intentionally NOT guarded
  // this way: it's terminal (sets do-not-disturb) and the team has chosen to
  // err toward never missing a real opt-out even at the cost of some false
  // positives, whereas STOP_WORD only pauses the auto-reply for staff to
  // look at, so the asymmetry doesn't apply here.
  if (!lastInbound.trim().endsWith("?") && STOP_WORDS_UPPER.some((w) => tokens.includes(w))) {
    return { blocked: true, code: "STOP_WORD" };
  }
  if (EMERGENCY_WORDS_LOWER.some((w) => lower.includes(w)) || EMERGENCY_911_RE.test(lower)) {
    return { blocked: true, code: "EMERGENCY_CONTENT" };
  }
  // Suitability is checked before medical so that phrases like
  // "which medication is right for me?" produce SUITABILITY_QUESTION rather
  // than MEDICAL_CONTENT (the word "medication" is in MEDICAL_WORDS_LOWER).
  if (SUITABILITY_PHRASES_LOWER.some((w) => lower.includes(w))) {
    return { blocked: true, code: "SUITABILITY_QUESTION" };
  }
  // Active side-effect reports get their own code — see SIDE_EFFECT_PHRASES_LOWER's
  // docstring — checked before the generic medical-words check for the same
  // reason as suitability above.
  if (SIDE_EFFECT_PHRASES_LOWER.some((w) => lower.includes(w))) {
    return { blocked: true, code: "SIDE_EFFECT_REPORT" };
  }
  // Shipping timing is also checked before medical, same reasoning: "how
  // long will it take to get my medication?" must not be blocked just
  // because it contains "medication" — see SHIPPING_TIMING_PHRASES_LOWER.
  if (SHIPPING_TIMING_PHRASES_LOWER.some((w) => lower.includes(w))) {
    return { blocked: false };
  }
  // Same reasoning for "how does the process work" questions — see
  // PROCESS_QUESTION_PHRASES_LOWER.
  if (PROCESS_QUESTION_PHRASES_LOWER.some((w) => lower.includes(w))) {
    return { blocked: false };
  }
  if (MEDICAL_WORDS_LOWER.some((w) => lower.includes(w))) {
    // A real production case: Alexis asked an open clarifying question ("is
    // there something specific about the process you'd like me to go
    // over?"), the customer answered "Medication and plans" — just naming
    // one of our own topics, not raising an unprompted medical concern —
    // and the bare word "medication" blocked it into a generic "that's for
    // the doctor" deflection instead of letting Claude actually explain it
    // (bounded by the normal knowledge-topic/post-check rules either way).
    // Exempted only when we ourselves just asked something (ourLastQuestion
    // is set) AND the reply is short (<=4 words) AND doesn't itself read as
    // a question — long enough to matter but short enough that it's
    // implausible as an independent statement/disclosure of its own. A
    // genuine unprompted disclosure ("I'm on this medication and want to
    // switch") is either longer than this, phrased as its own question, or
    // doesn't follow a question we just asked — any of those still blocks.
    const isShortAnswerToOurOwnQuestion = Boolean(ourLastQuestion) && !lastInbound.includes("?") && tokens.filter(Boolean).length <= 4;
    if (!isShortAnswerToOurOwnQuestion) {
      return { blocked: true, code: "MEDICAL_CONTENT" };
    }
  }
  if (LEGAL_WORDS_LOWER.some((w) => lower.includes(w)) || LEGAL_SUE_RE.test(lower)) {
    return { blocked: true, code: "LEGAL_CONTENT" };
  }

  return { blocked: false };
}

// ── Post-check patterns ───────────────────────────────────────────────────────

/**
 * Matches a URL WITH OR WITHOUT an explicit http(s):// scheme — a bare
 * "tryark-fake.com/abc" is just as much an output link as
 * "https://tryark-fake.com/abc", and the old scheme-required pattern let
 * a schemeless link through the UNAPPROVED_URL check entirely. Scheme is
 * optional; everything else about the shape (domain + recognized TLD +
 * optional path/query) still has to look like a URL.
 */
const URL_RE = /(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|co)\b(?:\/[^\s)]*)?/gi;

/** Strips scheme/www/trailing-slash so an approved URL still matches whether or not Claude echoes its scheme. */
function normalizeUrlForComparison(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

const APPROVED_REVIEW_URLS_NORMALIZED = new Set([...APPROVED_REVIEW_URLS].map(normalizeUrlForComparison));

/**
 * Clinical content ALWAYS rejected, regardless of which Alexis knowledge topics
 * were declared in knowledgeTopicsUsed. These patterns describe individualized
 * medical actions or conditions that Claude must never perform or assert — even
 * when grounded in a Alexis topic — because they cross from general educational
 * information into individualized clinical judgment.
 *
 * "symptom" is included here because it does not appear in any Alexis approved
 * text and its presence in a reply strongly signals individualized assessment.
 */
// contraindicat(e|ed|es|ing|ion|ions) — was verb-only (contraindicated?), missing the noun form "contraindication(s)".
const UNCONDITIONAL_CLINICAL_RE = [/\bdiagnos(e|is|ed|ing)\b/i, /\bcontraindicat(e|ed|es|ing|ion|ions)\b/i, /\bsymptom/i] as const;

/**
 * Topic-specific language rules.
 *
 * Each entry pairs a sensitive-language pattern with the set of Alexis topic keys
 * that MUST be declared in knowledgeTopicsUsed for the pattern to be permitted.
 * If none of the required topics is declared, the reply is rejected with `code`.
 *
 * A Set with multiple keys means the pattern is legitimately used in more than
 * one topic's approved content. Any one of the listed keys is sufficient.
 *
 * Words not listed here are never independently blocked:
 *   "medication", "prescription" (noun), "dose" (noun), "titration".
 */
interface TopicSpecificRule {
  readonly pattern: RegExp;
  readonly requiredTopics: ReadonlySet<string>;
  readonly code: "PROHIBITED_CLINICAL" | "UNSUPPORTED_PRICING_CLAIM";
}

const TOPIC_SPECIFIC_LANGUAGE: readonly TopicSpecificRule[] = [
  {
    // "dosing" / "dosage" — dose-progression educational content
    // Requires: titration
    pattern: /\bdos(age?|ing)\b/i,
    requiredTopics: new Set(["titration"]),
    code: "PROHIBITED_CLINICAL",
  },
  {
    // "prescribed" / "prescribe" — transfer-patient context only
    // Requires: previous_prescriptions
    pattern: /\bprescri(be|bed)\b/i,
    requiredTopics: new Set(["previous_prescriptions"]),
    code: "PROHIBITED_CLINICAL",
  },
  {
    // "treatment" — appears in both transfer-patient context ("transferring treatment")
    //               and titration context ("your treatment process").
    // Requires: previous_prescriptions OR titration
    pattern: /\btreat(ment|ing|ed|s)\b/i,
    requiredTopics: new Set(["previous_prescriptions", "titration"]),
    code: "PROHIBITED_CLINICAL",
  },
  {
    // Injection language — titration or product-comparison educational context
    // Requires: titration OR product_comparison
    pattern: /\binject(ion|ing|ed)?\b/i,
    requiredTopics: new Set(["titration", "product_comparison"]),
    code: "PROHIBITED_CLINICAL",
  },
  {
    // "side effects" — allowed with the dedicated side_effects topic, or when
    // discussing product comparison / weight-loss expectations more broadly.
    // Requires: side_effects OR weight_loss_expectations OR product_comparison
    pattern: /\bside.?effect/i,
    requiredTopics: new Set(["side_effects", "weight_loss_expectations", "product_comparison"]),
    code: "PROHIBITED_CLINICAL",
  },
  {
    // Payment platform names — only in insurance / payment-options context.
    // A reply mentioning Affirm, Klarna, or Afterpay without the insurance_payment
    // topic is an unsupported pricing / payment claim.
    // Requires: insurance_payment
    pattern: /\b(affirm|klarna|afterpay)\b/i,
    requiredTopics: new Set(["insurance_payment"]),
    code: "UNSUPPORTED_PRICING_CLAIM",
  },
];

/**
 * Claims always rejected regardless of which knowledge topics were used.
 * Dollar amounts are handled separately (topic-gated).
 * "insurance" is also handled separately (topic-gated to insurance_payment).
 */
const GUARANTEED_PRICING_RE = [/\bfree\s+(trial|month|consultation)\b/i, /\bguarantee[sd]?\b/i, /\bfully?\s+covered\b/i] as const;

/**
 * Unsupported financing-term claims — always rejected regardless of which
 * knowledge topics were used. These phrases imply availability, eligibility,
 * or terms for BNPL / payment-plan financing that are not approved text.
 *
 *   "available at checkout" — implies automatic platform integration not promised.
 *   "everyone qualifies"    — implies guaranteed eligibility for all applicants.
 *   "no credit check"       — implies a specific underwriting guarantee we cannot make.
 *   "zero interest"         — invents financing terms absent from approved language.
 *
 * Declaring the insurance_payment topic does NOT unlock these phrases.
 */
const UNSUPPORTED_FINANCING_RE = [
  /\bavailable\s+at\s+checkout\b/i,
  /\beveryone\s+qualifies\b/i,
  /\bno\s+credit[\s-]check\b/i,
  /\bzero[\s-]interest\b/i,
] as const;

/**
 * Insurance-acceptance verb patterns used by hasUnnegatedInsuranceAcceptance().
 * All use the /gi flag; callers must reset lastIndex before use.
 *
 * Covered forms:
 *   accept / accepts / accepted [0–3 intervening words] insurance
 *   insurance [auxiliary] accepted  (passive: "insurance is accepted", "may be accepted")
 *   work / works / worked with [0–2 words] insurance
 *   bill / bills / billed [0–2 words] insurance
 *   take / takes / took [0–3 words] insurance
 *   honor / honors / honored [0–2 words] insurance
 *   insurance covers / will cover / is covered  (active and passive)
 *   covered by [0–2 words] insurance
 *   use [0–2 words] insurance
 *   in-network with [0–3 words] insurance
 *   insurance [is] welcome
 */
const INSURANCE_ACCEPTANCE_PATTERNS: readonly RegExp[] = [
  /\baccept(?:s|ed)?\s+(?:\w+\s+){0,3}insurance\b/gi,
  /\binsurance\s+(?:(?:is|are|was|were|gets?)\s+|(?:will|may|might|could|should)\s+be\s+)accepted\b/gi,
  /\bwork(?:s|ed)?\s+with\s+(?:\w+\s+){0,2}insurance\b/gi,
  /\bbill(?:s|ed)?\s+(?:\w+\s+){0,2}insurance\b/gi,
  /\b(?:tak(?:e|es|en)|took)\s+(?:\w+\s+){0,3}insurance\b/gi,
  /\bhonor(?:s|ed)?\s+(?:\w+\s+){0,2}insurance\b/gi,
  /\binsurance\s+(?:(?:usually|typically|often|generally)\s+)?(?:(?:will|may|might|could|should)\s+)?covers?\b/gi,
  /\binsurance\s+(?:is|are|was|were)\s+covered\b/gi,
  /\bcover(?:ed|s)?\s+by\s+(?:\w+\s+){0,2}insurance\b/gi,
  /\buse\s+(?:\w+\s+){0,2}insurance\b/gi,
  /\bin[\s-]network\s+(?:\w+\s+){0,3}insurance\b/gi,
  /\binsurance\s+(?:is\s+)?welcome\b/gi,
];

/**
 * Negation markers that, when present before an insurance-acceptance verb within its
 * clause, indicate the claim is correctly negated (approved form).
 *
 * Includes contracted negated "to be" forms (isn't/aren't/wasn't/weren't) — without
 * these, a correctly-negated claim built on a "covered"/"welcome" pattern ("This
 * isn't covered by insurance") was wrongly treated as unnegated and blocked, since
 * "is not" (spelled out) was covered but its contraction wasn't.
 */
const INSURANCE_ACCEPTANCE_NEGATION_RE =
  /\b(don't|do\s+not|doesn't|does\s+not|didn't|did\s+not|won't|will\s+not|can't|cannot|could\s+not|may\s+not|might\s+not|isn't|is\s+not|aren't|are\s+not|wasn't|was\s+not|weren't|were\s+not|never|not)\b/;

/**
 * Insurance mention — permitted when the insurance_payment Alexis topic is
 * declared in knowledgeTopicsUsed, e.g.
 *   "We don't accept insurance, but payment options are available through …"
 * Blocked (UNSUPPORTED_PRICING_CLAIM) when no insurance_payment topic is declared.
 */
const INSURANCE_MENTION_RE = /\binsur(e|ance)\b/i;

/**
 * Dollar-amount pattern — only blocked when no approved pricing topic is used.
 * Handles cents (e.g. "$116.67") and comma thousands-separators (e.g.
 * "$1,100") — Ark Health's plan prices use both, unlike Luma's original
 * whole-dollar-only pricing, so a plain /\$\d+/ would either truncate a
 * decimal price at the "." or truncate a 4-digit price at the first comma.
 */
const DOLLAR_AMOUNT_RE = /\$\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?/;
const DOLLAR_AMOUNT_GLOBAL_RE = /\$(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/g;

/** Strips comma thousands-separators so "$1,100" and "$1100" compare equal. */
function normalizeDollarAmount(raw: string): string {
  return raw.replace(/,/g, "");
}

/**
 * Every dollar figure that ever appears in approved pricing content: the two
 * product catalogs (semaglutide/tirzepatide, all four plan lengths, monthly
 * and total, plus the "save $X" figure each plan states), the $20 promo
 * discount itself, and the two promo-adjusted month-to-month prices the
 * prompt tells Claude to quote once promoOffered is true (see provider.ts's
 * promoState text). Declaring a pricing topic only proves Claude cited *a*
 * topic — it says nothing about whether the number it then quotes is one of
 * these. This closes that gap: once any pricing topic is declared, every
 * dollar amount in the reply must be a member of this set (compared after
 * normalizeDollarAmount), not just "a topic was mentioned somewhere."
 */
const APPROVED_DOLLAR_AMOUNTS = new Set([
  "20", // promo discount amount
  // semaglutide: month-to-month, 3/6/12-month monthly + total + save
  "175", "116.67", "350", "108.33", "650", "400", "91.67", "1100", "1000",
  // tirzepatide: month-to-month, 3/6/12-month monthly + total + save
  "225", "188.33", "565", "110", "1050", "300", "125", "1500", "1200",
  // promo-adjusted month-to-month prices (promoState in provider.ts)
  "155", "205",
]);

/**
 * The only approved promotional discount amount.
 * When first_month_offer is the sole pricing topic declared (no product pricing topic),
 * any dollar amount in the reply must match this; other amounts are invented discounts.
 */
const APPROVED_PROMOTION_AMOUNT_RE = /\$20\b/;

/**
 * Affirmative stacking claim — always blocked.
 * "can be combined with" / "stackable" / "stacks with" promise stacking which is
 * prohibited by the first_month_offer approved text ("cannot be combined with another
 * promotion").
 *
 * Does NOT match "cannot be combined" — the negative form is the correct approved language.
 */
const PROMOTION_STACKING_RE = /\bcan\s+be\s+combin(ed|able)\s+with\b|\bstack(able|s\s+with)\b/i;

/**
 * Non-new-customer eligibility claim — always blocked when first_month_offer is declared.
 * Catches language that implies returning or previous customers qualify for the $20 offer.
 */
const PROMOTION_ELIGIBILITY_VIOLATION_RE =
  /\b(returning|previous|prior|existing)\s+(customers?|patients?)\s+(can|are)\s+(also\s+)?(get|receive|eligible?|qualify)\b/i;

const STAFF_AVAIL_RE = /\b(monitoring|monitored|watching|standing\s+by|on\s+call).{0,40}(24\/7|around\s+the\s+clock|all\s+the\s+time|right\s+now)\b/i;

// Allowed template variable names
const ALLOWED_TEMPLATE_NAMES = new Set([
  "UNIVERSAL_SIGNUP_LINK",
  "SEMAGLUTIDE_PRICING_PENDING_APPROVAL",
  "TIRZEPATIDE_PRICING_PENDING_APPROVAL",
  "PROCESS_DESCRIPTION_PENDING_APPROVAL",
  "PLAN_INCLUSIONS_PENDING_APPROVAL",
]);

const TEMPLATE_VAR_RE = /\[([A-Z_]+)\]/g;

// Allowed slot keys and the values each accepts
const SLOT_VALIDATORS: Record<string, readonly (string | null)[]> = {
  selectedProduct: [null, "semaglutide", "tirzepatide"],
  currentlyTaking: [null, "yes", "no"],
  wantsProcessExplanation: [null, "yes", "no"],
  hasTimeForIntake: [null, "yes", "no"],
  wantsPlanInclusions: [null, "yes", "no"],
  readyForForm: [null, "yes", "no"],
};

/**
 * Slot keys that hold free text rather than a fixed enum, validated by shape
 * (non-empty, bounded length) instead of membership. `state` is informational
 * only — it never gates eligibility, since every state is serviced.
 */
const FREE_TEXT_SLOT_KEYS = new Set(["state"]);
const FREE_TEXT_MAX_LENGTH = 60;

function isValidFreeTextSlotValue(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.trim().length > 0 && value.length <= FREE_TEXT_MAX_LENGTH);
}

// Actions for which nextQuestion must be a valid single question
const REPLY_TYPE_ACTIONS = new Set(["reply", "ask_product", "explain_process", "explain_pricing", "explain_inclusions"]);

// Actions for which nextQuestion must be null
const NO_QUESTION_ACTIONS = new Set(["pause", "send_form", "staff_review", "no_reply"]);

/**
 * Returns true when the reply contains an affirmative (un-negated) insurance-
 * acceptance claim. The only approved insurance policy is that Ark does NOT
 * accept insurance; any form that implies it may be accepted must be rejected.
 *
 * Detection strategy — normalise-and-verify (not a pure lookbehind):
 *
 *  1. Scan for every occurrence of an insurance-acceptance verb pattern.
 *  2. Extract the "negation zone": text from the start of the containing clause
 *     (bounded by the nearest preceding .!?;, character) to the start of the
 *     matched verb phrase. Commas are included as clause separators so that an
 *     adversative sub-clause ("…, but we also accept insurance") is correctly
 *     isolated from an earlier negation ("We don't accept insurance,…").
 *  3. If a clear negation marker (don't, do not, cannot, never, …) appears in the
 *     negation zone, the claim is correctly negated → pass.
 *  4. If no negation marker is found for any occurrence → block (returns true).
 *
 * Approved forms (must pass):
 *   "We don't accept insurance."
 *   "We do not accept insurance."
 *   "We don't accept insurance, but payment options are available through Affirm,
 *    Klarna, and Afterpay, subject to approval."
 *
 * Rejected regardless of topic declared (must fail):
 *   "We accept insurance."              "Ark accepts insurance."
 *   "Insurance is accepted."            "We can accept insurance."
 *   "We may accept insurance."          "We accept some insurance."
 *   "We accept insurance indirectly."   "Your insurance is accepted."
 *   "We work with your insurance."      "We can bill your insurance."
 *   "We take insurance."                "Your insurance covers this."
 *   "This is covered by insurance."     "We honor insurance plans."
 *   "Insurance is welcome here."        "You can use your insurance for this."
 *   "We're in-network with insurance."  "Insurance may cover part of this."
 */
function hasUnnegatedInsuranceAcceptance(reply: string): boolean {
  const lower = reply.toLowerCase();

  for (const pattern of INSURANCE_ACCEPTANCE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lower)) !== null) {
      // Locate the start of the containing clause: scan backward from the match
      // for the nearest sentence-ending punctuation or comma.
      let clauseStart = 0;
      for (let i = match.index - 1; i >= 0; i--) {
        const ch = lower[i];
        if (ch === "." || ch === "!" || ch === "?" || ch === ";" || ch === ",") {
          clauseStart = i + 1;
          break;
        }
      }
      // Negation zone: text between clause start and the start of the matched verb.
      const negationZone = lower.substring(clauseStart, match.index);
      if (!INSURANCE_ACCEPTANCE_NEGATION_RE.test(negationZone)) {
        return true; // affirmative insurance-acceptance claim → block
      }
    }
  }

  return false;
}

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[.,!?;:'"—\-]+/g, "")
    .replace(/\s+/g, " ");
}

// ── Reply sentence-order helpers ──────────────────────────────────────────────

export type InteractivePostCheckResult =
  | { readonly ok: true; readonly result: ClaudeInteractiveResult; readonly validatedSlotUpdates: Record<string, unknown> }
  | { readonly ok: false; readonly code: string };

/**
 * Validate the raw provider response.
 *
 * Hard rejections (returns ok:false):
 *   UNAPPROVED_URL, PROHIBITED_CLINICAL, UNSUPPORTED_PRICING_CLAIM,
 *   PROHIBITED_STAFF_CLAIM, DISALLOWED_TEMPLATE, REPEATED_DRAFT,
 *   LOW_CONFIDENCE, INVALID_SLOT_KEY, INVALID_SLOT_VALUE,
 *   UNKNOWN_KNOWLEDGE_TOPIC, MISSING_NEXT_QUESTION, INVALID_NEXT_QUESTION
 *
 * @param permittedTopicKeys  Set of knowledge topic keys that were sent to the
 *   provider. Any key in knowledgeTopicsUsed that is not in this set is
 *   rejected as UNKNOWN_KNOWLEDGE_TOPIC. Pass an empty Set to skip the check.
 */
export function interactivePostCheck(
  raw: ClaudeInteractiveResult,
  lastDraft: string | null,
  permittedTopicKeys: ReadonlySet<string> = new Set(),
): InteractivePostCheckResult {
  const { reply } = raw;

  if (reply !== null) {
    // URL — only the fixed review-site URLs are allowed. No intake/signup URL
    // is ever allowlisted here: those are minted per-lead server-side (see
    // knowledge-catalog.ts's APPROVED_REVIEW_URLS docstring) and Claude must
    // never output one, even a real one from a prior turn.
    URL_RE.lastIndex = 0;
    const urlMatches = [...reply.matchAll(URL_RE)];
    for (const match of urlMatches) {
      // Strip trailing punctuation that might be appended by Claude
      const url = match[0].replace(/[.,;)'"]+$/, "");
      if (!APPROVED_REVIEW_URLS_NORMALIZED.has(normalizeUrlForComparison(url))) {
        return { ok: false, code: "UNAPPROVED_URL" };
      }
    }

    // The question belongs exclusively in nextQuestion. Catches Claude folding a
    // clarifying question into reply and leaving nextQuestion null or mismatched —
    // observed live: Claude re-asking "which one — semaglutide or tirzepatide?"
    // inside reply instead of splitting it out.
    if (reply.includes("?")) {
      return { ok: false, code: "QUESTION_MARK_IN_REPLY" };
    }

    // ── Clinical-language checks ───────────────────────────────────────────────
    const hasInsuranceTopic = raw.knowledgeTopicsUsed.includes("insurance_payment");

    // Always blocked: individualized clinical actions / conditions
    if (UNCONDITIONAL_CLINICAL_RE.some((re) => re.test(reply))) {
      return { ok: false, code: "PROHIBITED_CLINICAL" };
    }

    // Topic-specific language: each pattern requires its designated Alexis topic(s).
    // A reply is rejected if it uses sensitive language without declaring the
    // specific topic that authorises that language. Declaring an unrelated topic
    // does not unlock permission for a different topic's sensitive vocabulary.
    for (const rule of TOPIC_SPECIFIC_LANGUAGE) {
      if (rule.pattern.test(reply)) {
        const hasRequired = raw.knowledgeTopicsUsed.some((k) => rule.requiredTopics.has(k));
        if (!hasRequired) {
          return { ok: false, code: rule.code };
        }
      }
    }

    // Guaranteed / unsupported claims (always blocked)
    if (GUARANTEED_PRICING_RE.some((re) => re.test(reply))) {
      return { ok: false, code: "UNSUPPORTED_PRICING_CLAIM" };
    }

    // Unsupported financing terms — always blocked, even when insurance_payment is declared.
    // "available at checkout", "everyone qualifies", "no credit check", "zero interest" are
    // not part of any approved messaging and imply guarantees we cannot make.
    if (UNSUPPORTED_FINANCING_RE.some((re) => re.test(reply))) {
      return { ok: false, code: "UNSUPPORTED_PRICING_CLAIM" };
    }

    // Affirmative insurance-acceptance — always blocked regardless of insurance_payment topic.
    // hasUnnegatedInsuranceAcceptance() normalises the reply and verifies that every
    // insurance-acceptance verb is explicitly negated (don't / do not / cannot / never / …).
    // Approved: "We don't accept insurance." Rejected: "We accept insurance." and all
    // other affirmative / passive / modal forms listed in the function's JSDoc.
    if (hasUnnegatedInsuranceAcceptance(reply)) {
      return { ok: false, code: "UNSUPPORTED_PRICING_CLAIM" };
    }

    // Insurance mention: blocked when the insurance_payment topic is not declared
    if (!hasInsuranceTopic && INSURANCE_MENTION_RE.test(reply)) {
      return { ok: false, code: "UNSUPPORTED_PRICING_CLAIM" };
    }

    // Dollar-amount claims only blocked when no approved pricing topic was used
    const hasPricingTopic = raw.knowledgeTopicsUsed.some((k) => APPROVED_PRICING_TOPIC_KEYS.has(k));
    if (!hasPricingTopic && DOLLAR_AMOUNT_RE.test(reply)) {
      return { ok: false, code: "UNSUPPORTED_PRICING_CLAIM" };
    }

    // A pricing topic being declared only proves Claude cited one — it doesn't
    // prove the number is real. Every dollar amount quoted must be one of the
    // actual approved figures, not just "some number, with a pricing topic
    // attached." Catches e.g. knowledgeTopicsUsed:["tirzepatide_pricing"] with
    // reply "$299 a month" — a fabricated price that the topic-only check above
    // would otherwise wave through.
    if (hasPricingTopic) {
      DOLLAR_AMOUNT_GLOBAL_RE.lastIndex = 0;
      for (const match of reply.matchAll(DOLLAR_AMOUNT_GLOBAL_RE)) {
        if (!APPROVED_DOLLAR_AMOUNTS.has(normalizeDollarAmount(match[1]))) {
          return { ok: false, code: "UNSUPPORTED_PRICING_CLAIM" };
        }
      }
    }

    // ── Promotion-specific rules (active whenever first_month_offer is declared) ─
    const hasFirstMonthOffer = raw.knowledgeTopicsUsed.includes("first_month_offer");

    if (hasFirstMonthOffer) {
      // Stacking claims are always prohibited — the approved text explicitly states
      // "cannot be combined with another promotion."
      if (PROMOTION_STACKING_RE.test(reply)) {
        return { ok: false, code: "UNSUPPORTED_PRICING_CLAIM" };
      }

      // Non-new-customer eligibility — discount applies to new customers only.
      if (PROMOTION_ELIGIBILITY_VIOLATION_RE.test(reply)) {
        return { ok: false, code: "UNSUPPORTED_PRICING_CLAIM" };
      }

      // Invented discount amount — when first_month_offer is the only pricing topic
      // (no product pricing topic declared), any dollar amount must be exactly $20.
      const hasProductPricingTopic = raw.knowledgeTopicsUsed.some((k) => PRODUCT_PRICING_TOPIC_KEYS.has(k));
      if (!hasProductPricingTopic && DOLLAR_AMOUNT_RE.test(reply) && !APPROVED_PROMOTION_AMOUNT_RE.test(reply)) {
        return { ok: false, code: "UNSUPPORTED_PRICING_CLAIM" };
      }
    }

    // Staff availability claim
    if (STAFF_AVAIL_RE.test(reply)) {
      return { ok: false, code: "PROHIBITED_STAFF_CLAIM" };
    }

    // Disallowed template variables
    const templateMatches = [...reply.matchAll(TEMPLATE_VAR_RE)];
    for (const match of templateMatches) {
      if (!ALLOWED_TEMPLATE_NAMES.has(match[1])) {
        return { ok: false, code: "DISALLOWED_TEMPLATE" };
      }
    }

    // Repeated draft
    if (lastDraft !== null && normalizeForComparison(reply) === normalizeForComparison(lastDraft)) {
      return { ok: false, code: "REPEATED_DRAFT" };
    }

    // Low confidence — hard reject (caller can choose to surface to staff)
    if (raw.confidence < 0.5) {
      return { ok: false, code: "LOW_CONFIDENCE" };
    }
  }

  // Knowledge-topic validation: reject any topic Claude cited that was not in
  // the permitted set we sent it. Skip the check when permittedTopicKeys is
  // empty (e.g. tests that do not exercise the knowledge path).
  if (permittedTopicKeys.size > 0) {
    for (const key of raw.knowledgeTopicsUsed) {
      if (!permittedTopicKeys.has(key)) {
        return { ok: false, code: "UNKNOWN_KNOWLEDGE_TOPIC" };
      }
    }
  }

  // nextQuestion validation + mandatory STATEMENT → QUESTION order check
  if (REPLY_TYPE_ACTIONS.has(raw.action)) {
    const nq = raw.nextQuestion;
    if (nq === null || nq === undefined || nq.trim() === "") {
      return { ok: false, code: "MISSING_NEXT_QUESTION" };
    }
    const trimmed = nq.trim();
    if (!trimmed.endsWith("?")) {
      return { ok: false, code: "INVALID_NEXT_QUESTION" };
    }
    const qCount = (trimmed.match(/\?/g) ?? []).length;
    if (qCount !== 1) {
      return { ok: false, code: "INVALID_NEXT_QUESTION" };
    }
    // reply and nextQuestion are separate messages — no order check needed.
    // The question lives exclusively in nextQuestion; reply is informational only.
  } else if (NO_QUESTION_ACTIONS.has(raw.action)) {
    if (raw.nextQuestion !== null && raw.nextQuestion !== undefined) {
      return { ok: false, code: "UNEXPECTED_NEXT_QUESTION" };
    }
  }

  // If Claude itself flagged requiresStaff, override the action to staff_review.
  // This provides a safety net for suitability questions that slip through
  // the pre-check; Claude's reply is discarded.
  const effectiveRaw: ClaudeInteractiveResult =
    raw.requiresStaff && raw.action !== "staff_review" ? { ...raw, action: "staff_review", reply: null, nextQuestion: null } : raw;

  // Validate slot updates
  const rawSlotUpdates = effectiveRaw.slotUpdates as Record<string, unknown>;
  const validatedSlotUpdates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawSlotUpdates)) {
    if (FREE_TEXT_SLOT_KEYS.has(key)) {
      if (!isValidFreeTextSlotValue(value)) {
        return { ok: false, code: `INVALID_SLOT_VALUE` };
      }
      validatedSlotUpdates[key] = value;
      continue;
    }
    const allowed = SLOT_VALIDATORS[key];
    if (!allowed) {
      return { ok: false, code: `INVALID_SLOT_KEY` };
    }
    if (!allowed.includes(value as string | null)) {
      return { ok: false, code: `INVALID_SLOT_VALUE` };
    }
    validatedSlotUpdates[key] = value;
  }

  const sanitizedRaw: ClaudeInteractiveResult = {
    ...effectiveRaw,
    reply: stripEmDashes(effectiveRaw.reply),
    nextQuestion: stripEmDashes(effectiveRaw.nextQuestion),
  };

  return { ok: true, result: sanitizedRaw, validatedSlotUpdates };
}
