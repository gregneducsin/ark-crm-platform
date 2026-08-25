/**
 * Pre- and post-Claude safety rules for Sophie, the post-purchase support bot.
 *
 * Sophie has almost no approved clinical content. Any patient message asking
 * about prescription specifics (dose, side effects, "why was I prescribed
 * this") is routed to staff before Sophie ever drafts a reply. Sophie's own
 * replies may reference prescription/order *status* (written, shipped,
 * tracking number) using the plain factual language the order-state context
 * provides — that's not clinical content, it's fulfillment status — but
 * individualized clinical language (diagnosis, dosing, symptoms, side
 * effects) in her own draft is unconditionally rejected, no exceptions.
 *
 * The one topic-gated carve-out is compounded_medication: naming a
 * medication (generic or brand — semaglutide/Ozempic, tirzepatide/Mounjaro/
 * Zepbound) is permitted only when that topic is declared in
 * knowledgeTopicsUsed, for general product-comparison questions a patient
 * raises by name. See SOPHIE_TOPIC_SPECIFIC_LANGUAGE below.
 *
 * No database imports. No outbound messaging SDK imports.
 */

import { z } from "zod";
import type { SophieInteractiveResult } from "./types.js";
import { APPROVED_REVIEW_URLS, APPROVED_PORTAL_URL, APPROVED_REVIEW_WRITE_URL } from "../messaging/knowledge-catalog.js";
import { stripEmDashes } from "../text-sanitize.js";

// ── Zod schema for structured provider output ─────────────────────────────────

export const SophieInteractiveSchema = z
  .object({
    action: z.enum(["reply", "pause", "staff_review", "no_reply"]),
    // 600, not Alexis's 400 — the review-request flow can legitimately need to
    // embed both full approved review URLs (~90 chars alone) plus natural
    // prose in one reply; 400 was observed live to reject valid replies here
    // (a 419-char reply with both URLs + enthusiastic phrasing).
    reply: z.string().max(600).nullable(),
    confidence: z.number().min(0).max(1),
    detectedIntents: z.array(z.string().max(100)).optional().default([]),
    knowledgeTopicsUsed: z.array(z.string().max(100)).optional().default([]),
    requiresStaff: z.boolean().optional().default(false),
    safetyCodes: z.array(z.string()).optional().default([]),
    nextQuestion: z.string().max(300).nullable().optional().default(null),
    inboundSentiment: z.enum(["positive", "neutral", "negative"]).nullable().optional().default(null),
  })
  .superRefine((data, ctx) => {
    const needsReply = ["reply", "pause"].includes(data.action);
    if (needsReply && !data.reply) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `reply must be a non-empty string for action: ${data.action}`, path: ["reply"] });
    }
    const mustBeNull = ["staff_review", "no_reply"].includes(data.action);
    if (mustBeNull && data.reply !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `reply must be null for action: ${data.action}`, path: ["reply"] });
    }
  });

// ── Pre-check keyword lists ───────────────────────────────────────────────────

const OPT_OUT_WORDS_UPPER = ["STOP", "UNSUBSCRIBE"] as const;
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
const STOP_WORDS_UPPER = ["END", "QUIT"] as const;
const EMERGENCY_WORDS_LOWER = ["emergency", "crisis", "suicide", "self-harm", "self harm"] as const;

/** "911" as a standalone token — see the matching comment in messaging/safety.ts for why a plain substring check false-positives on order numbers, zip codes, and phone numbers. */
const EMERGENCY_911_RE = /(?<!\d)911(?!\d)/;
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
 * Any question about prescription specifics — dose, medication identity,
 * refill changes, side effects, "is this safe" — routes straight to staff.
 * Sophie has no approved content to answer any of these; unlike Alexis's
 * MEDICAL_WORDS_LOWER (which has topic-gated post-check carve-outs), there
 * is deliberately no exception path here.
 */
const PRESCRIPTION_QUESTION_PHRASES_LOWER = [
  // Dose specifics — any mention at all routes to staff. Was previously
  // limited to "what dose"/"my dose"/specific increase-decrease phrasings,
  // which missed plain rephrasings like "how many mg do I take" or
  // "my dose hasn't changed" that don't happen to match one of the
  // anticipated patterns. Bare "dose"/"mg" catches the concept regardless
  // of phrasing — there's no legitimate non-clinical reason for a patient
  // message to contain either word.
  "dose",
  "doses",
  "dosage",
  "dosing",
  "side effect",
  "diagnosis",
  "diagnose",
  "symptom",
  "why was i prescribed",
  "why am i prescribed",
  "why did you prescribe",
  "why am i on",
  "what medication am i",
  "which medication am i",
  "what am i taking",
  "what am i on",
  "change my prescription",
  "different medication",
  "switch my medication",
  "change the medication",
  "refill early",
  // "is it safe" narrowed to medication-context tails, not the bare phrase —
  // a bare substring also matched non-clinical questions like "is it safe to
  // leave the package on my porch," silently routing an ordinary delivery
  // question to staff instead of letting Sophie answer it.
  "is it safe for me",
  "is it safe to take",
  "is it safe to combine",
  "is it safe to mix",
  "is it safe with",
  "interact with",
  "allergic",
  "contraindicat",
] as const;

/**
 * "mg" as a dosage unit — split out from the phrase list above because a
 * bare substring check also matches inside "omg," an extremely common
 * casual expression ("OMG thank you so much!!") that has nothing to do with
 * dosage. Matches a standalone "mg" word (surrounded by non-word characters,
 * e.g. "how many mg do I take") or a digit immediately followed by "mg"
 * ("5mg", "2.5mg") — real dosage mentions always take one of these two
 * shapes, "omg" takes neither.
 */
const MG_DOSAGE_RE = /\bmg\b|\d\s?mg\b/i;

/**
 * A patient reporting their medication's cold-chain may have failed in
 * transit (real production case: Virginia Kibler — "one ice pack, hot to
 * the touch, providing no refrigeration at all"). This is a potential
 * medication-safety issue, not a routine shipping complaint — Sophie has no
 * way to assess whether the medication is still safe to use, so this routes
 * straight to staff the same way a prescription question does, rather than
 * falling through to the generic "acknowledge and say the team will follow
 * up" fallback for uncovered topics.
 */
const COLD_CHAIN_CONCERN_PHRASES_LOWER = ["ice pack", "not refrigerated", "wasn't refrigerated", "no refrigeration", "not cold", "warm to the touch", "hot to the touch", "melted", "spoiled"] as const;

export type SupportPreCheckResult = { readonly blocked: false } | { readonly blocked: true; readonly code: string };

/**
 * Priority order: opt_out > STOP_WORD > emergency > prescription_question > cold_chain_concern > legal.
 */
export function supportPreCheck(lastInbound: string): SupportPreCheckResult {
  const upper = lastInbound.toUpperCase();
  const lower = lastInbound.toLowerCase();
  const tokens = upper.split(/\W+/);

  if (OPT_OUT_WORDS_UPPER.some((w) => tokens.includes(w))) return { blocked: true, code: "OPT_OUT" };
  if (OPT_OUT_PHRASES_LOWER.some((w) => lower.includes(w))) return { blocked: true, code: "OPT_OUT" };
  // See the matching comment in messaging/safety.ts's interactivePreCheck: a
  // message ending in "?" is excluded because "END"/"QUIT" as a bare word is
  // routinely just the tail of an unrelated question ("when does this end?").
  if (!lastInbound.trim().endsWith("?") && STOP_WORDS_UPPER.some((w) => tokens.includes(w))) return { blocked: true, code: "STOP_WORD" };
  if (EMERGENCY_WORDS_LOWER.some((w) => lower.includes(w)) || EMERGENCY_911_RE.test(lower)) return { blocked: true, code: "EMERGENCY_CONTENT" };
  if (PRESCRIPTION_QUESTION_PHRASES_LOWER.some((w) => lower.includes(w)) || MG_DOSAGE_RE.test(lower)) return { blocked: true, code: "PRESCRIPTION_QUESTION" };
  if (COLD_CHAIN_CONCERN_PHRASES_LOWER.some((w) => lower.includes(w))) return { blocked: true, code: "COLD_CHAIN_CONCERN" };
  if (LEGAL_WORDS_LOWER.some((w) => lower.includes(w)) || LEGAL_SUE_RE.test(lower)) return { blocked: true, code: "LEGAL_CONTENT" };

  return { blocked: false };
}

// ── Post-check patterns ───────────────────────────────────────────────────────

/**
 * Matches a URL WITH OR WITHOUT an explicit http(s):// scheme — see the
 * matching comment in messaging/safety.ts for why the scheme is optional.
 */
const URL_RE = /(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|co)\b(?:\/[^\s)]*)?/gi;

/** Strips scheme/www/trailing-slash so an approved URL still matches whether or not Sophie echoes its scheme. */
function normalizeUrlForComparison(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

const ALLOWED_URLS = new Set([...APPROVED_REVIEW_URLS, APPROVED_PORTAL_URL, APPROVED_REVIEW_WRITE_URL]);
const ALLOWED_URLS_NORMALIZED = new Set([...ALLOWED_URLS].map(normalizeUrlForComparison));

/**
 * Clinical content in Sophie's OWN reply — always rejected, no exceptions.
 * These describe individualized clinical judgment (diagnosis, dosing,
 * symptoms, side effects) that Sophie must never produce regardless of which
 * topic she's grounded in.
 * "prescription" as a plain status noun ("your prescription was written")
 * is NOT blocked here — only clinical specifics are.
 */
const SOPHIE_PROHIBITED_CLINICAL_RE = [
  /\bdiagnos(e|is|ed|ing)\b/i,
  // Was verb-only (contraindicated); "contraindication(s)" (the noun form) is
  // an equally common phrasing and was slipping through unblocked.
  /\bcontraindicat(e|ed|es|ing|ion|ions)\b/i,
  /\bsymptom/i,
  // Was "dosage/dosing" only — bare "dose"/"doses" ("your dose hasn't
  // changed") is the single most natural way to phrase this and wasn't
  // blocked at all.
  /\bdos(e|es|age|ages|ing)\b/i,
  /\bside.?effect/i,
  /\b\d+\s?mg\b/i,
] as const;

/**
 * Product-name language, topic-gated behind compounded_medication.
 *
 * A patient bringing up a brand name ("how is this different from Ozempic")
 * is asking for general product information, not individualized clinical
 * guidance — Sophie may answer using the compounded_medication topic (same
 * approved text Alexis uses). Without that topic declared, naming any
 * medication — generic or brand — is still rejected exactly as before.
 */
interface SophieTopicSpecificRule {
  readonly pattern: RegExp;
  readonly requiredTopics: ReadonlySet<string>;
  readonly code: "PROHIBITED_CLINICAL";
}

const SOPHIE_TOPIC_SPECIFIC_LANGUAGE: readonly SophieTopicSpecificRule[] = [
  {
    pattern: /\bsemaglutide\b|\btirzepatide\b|\bozempic\b|\bwegovy\b|\bmounjaro\b|\bzepbound\b/i,
    requiredTopics: new Set(["compounded_medication"]),
    code: "PROHIBITED_CLINICAL",
  },
];

const STAFF_AVAIL_RE = /\b(monitoring|monitored|watching|standing\s+by|on\s+call).{0,40}(24\/7|around\s+the\s+clock|all\s+the\s+time|right\s+now)\b/i;

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[.,!?;:'"—\-]+/g, "")
    .replace(/\s+/g, " ");
}

export type SupportPostCheckResult = { readonly ok: true; readonly result: SophieInteractiveResult } | { readonly ok: false; readonly code: string };

const REPLY_TYPE_ACTIONS = new Set(["reply"]);
const NO_QUESTION_ACTIONS = new Set(["pause", "staff_review", "no_reply"]);

/**
 * Validate Sophie's raw provider response.
 *
 * Hard rejections (returns ok:false): UNAPPROVED_URL, PROHIBITED_CLINICAL,
 * PROHIBITED_STAFF_CLAIM, REPEATED_DRAFT, LOW_CONFIDENCE,
 * UNKNOWN_KNOWLEDGE_TOPIC, MISSING_NEXT_QUESTION, INVALID_NEXT_QUESTION,
 * QUESTION_MARK_IN_REPLY, UNEXPECTED_NEXT_QUESTION.
 */
export function supportPostCheck(
  raw: SophieInteractiveResult,
  lastDraft: string | null,
  permittedTopicKeys: ReadonlySet<string> = new Set(),
): SupportPostCheckResult {
  const { reply } = raw;

  if (reply !== null) {
    URL_RE.lastIndex = 0;
    const urlMatches = [...reply.matchAll(URL_RE)];
    for (const match of urlMatches) {
      const url = match[0].replace(/[.,;)'"]+$/, "");
      if (!ALLOWED_URLS_NORMALIZED.has(normalizeUrlForComparison(url))) {
        return { ok: false, code: "UNAPPROVED_URL" };
      }
    }

    // A "?" that's part of an approved URL's own query string (e.g.
    // ?brand_id=27277) isn't a clarifying question — strip matched URLs
    // before checking, so only a real "?" elsewhere in the text trips this.
    URL_RE.lastIndex = 0;
    const replyWithoutUrls = reply.replace(URL_RE, "");
    if (replyWithoutUrls.includes("?")) {
      return { ok: false, code: "QUESTION_MARK_IN_REPLY" };
    }

    if (SOPHIE_PROHIBITED_CLINICAL_RE.some((re) => re.test(reply))) {
      return { ok: false, code: "PROHIBITED_CLINICAL" };
    }

    for (const rule of SOPHIE_TOPIC_SPECIFIC_LANGUAGE) {
      if (rule.pattern.test(reply)) {
        const hasRequired = raw.knowledgeTopicsUsed.some((k) => rule.requiredTopics.has(k));
        if (!hasRequired) {
          return { ok: false, code: rule.code };
        }
      }
    }

    if (STAFF_AVAIL_RE.test(reply)) {
      return { ok: false, code: "PROHIBITED_STAFF_CLAIM" };
    }

    if (lastDraft !== null && normalizeForComparison(reply) === normalizeForComparison(lastDraft)) {
      return { ok: false, code: "REPEATED_DRAFT" };
    }

    if (raw.confidence < 0.5) {
      return { ok: false, code: "LOW_CONFIDENCE" };
    }
  }

  if (permittedTopicKeys.size > 0) {
    for (const key of raw.knowledgeTopicsUsed) {
      if (!permittedTopicKeys.has(key)) {
        return { ok: false, code: "UNKNOWN_KNOWLEDGE_TOPIC" };
      }
    }
  }

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
  } else if (NO_QUESTION_ACTIONS.has(raw.action)) {
    if (raw.nextQuestion !== null && raw.nextQuestion !== undefined) {
      return { ok: false, code: "UNEXPECTED_NEXT_QUESTION" };
    }
  }

  const effectiveRaw: SophieInteractiveResult =
    raw.requiresStaff && raw.action !== "staff_review" ? { ...raw, action: "staff_review", reply: null, nextQuestion: null } : raw;

  const sanitizedRaw: SophieInteractiveResult = {
    ...effectiveRaw,
    reply: stripEmDashes(effectiveRaw.reply),
    nextQuestion: stripEmDashes(effectiveRaw.nextQuestion),
  };

  return { ok: true, result: sanitizedRaw };
}
