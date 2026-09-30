/**
 * Human-readable explanations for why a conversation got flagged
 * needsAttention — shared across all four dispatch pipelines (Alexis SMS,
 * Alexis email, Sophie SMS, Sophie email), since they all draw from the same
 * three situations (an unexpected error, a rejected/blocked draft reply, or
 * Claude/a pre-check routing the turn to staff) and largely the same set of
 * codes. A bare boolean flag on the dashboard told staff SOMETHING needed
 * attention but never what — this is the difference between "check every
 * flagged thread by hand" and "know what to look for before opening it."
 *
 * No database imports. No outbound messaging SDK imports.
 */

import { AI_DIDNT_UNDERSTAND_REASON } from "@luma/shared";

export type NeedsAttentionSource =
  | { readonly kind: "exception" }
  | { readonly kind: "rejected"; readonly code: string }
  | { readonly kind: "staff_flagged"; readonly preCheckCode: string | null }
  | { readonly kind: "stuck_repeating" };

/** Post-check/provider rejection codes — the draft reply existed but got blocked before it ever reached the customer. */
const REJECTED_REASONS: Record<string, string> = {
  PROHIBITED_CLINICAL: "The draft reply included clinical/medical language that isn't allowed, so it was blocked instead of sent.",
  PROHIBITED_CLINICAL_ABSOLUTE:
    "The draft reply used clinical/medical language (diagnosing, contraindications, or symptoms) that's never allowed regardless of context, so it was blocked instead of sent.",
  UNSUPPORTED_PRICING_CLAIM: "The draft reply stated a price or discount that isn't backed by an approved pricing topic, so it was blocked.",
  UNAPPROVED_URL: "The draft reply included a link that isn't on the approved list, so it was blocked.",
  PROHIBITED_STAFF_CLAIM: "The draft reply promised something about staff availability/monitoring that isn't allowed, so it was blocked.",
  DISALLOWED_TEMPLATE: "The draft reply contained placeholder/template text that should never reach a customer, so it was blocked.",
  UNKNOWN_KNOWLEDGE_TOPIC: "The draft reply cited information outside the approved knowledge base, so it was blocked.",
  LOW_CONFIDENCE: "The reply wasn't confident enough in its own answer to send it.",
  REPEATED_DRAFT: "The same reply was drafted again instead of a new one, and retries didn't fix it — nothing was sent.",
  MISSING_NEXT_QUESTION: "The reply kept failing a required formatting check (missing follow-up question) after several tries, so nothing was sent.",
  INVALID_NEXT_QUESTION: "The reply kept failing a required formatting check (malformed follow-up question) after several tries, so nothing was sent.",
  UNEXPECTED_NEXT_QUESTION: "The reply kept failing a required formatting check (a follow-up question where none was expected) after several tries, so nothing was sent.",
  QUESTION_MARK_IN_REPLY: "The reply kept failing a required formatting check (a question mark landed in the wrong part of the message) after several tries, so nothing was sent.",
  PROVIDER_TIMEOUT: "The AI service timed out, so nothing was sent.",
  PROVIDER_HTTP_ERROR: "The AI service returned an error, so nothing was sent.",
  PROVIDER_NOT_CONFIGURED: "The AI provider isn't configured, so nothing was sent.",
  NO_JSON_OBJECT: "The AI's response was malformed, so nothing was sent.",
  JSON_PARSE_ERROR: "The AI's response was malformed, so nothing was sent.",
  SCHEMA_VALIDATION_ERROR: "The AI's response didn't match the expected format, so nothing was sent.",
  EMPTY_RESPONSE: "The AI returned an empty response, so nothing was sent.",
};

/**
 * Codes that route to staff review while still sending the customer
 * something — mostly pre-check codes (flagged before any reply is even
 * drafted), plus the NEVER_SILENT_CODES post-check exceptions
 * (alexis-conversation.service.ts): a reply kept failing the same mechanical
 * check even after every retry, so it was sent as drafted anyway instead of
 * a worse substitute or silence. Alexis's own reply text still goes out
 * as-is in every one of these cases — nothing here substitutes a different
 * message — this just tells staff which specific check it skipped, so they
 * know what to glance at.
 */
const STAFF_FLAGGED_REASONS: Record<string, string> = {
  STOP_WORD: "The customer used a word that might mean they want to stop texts, but it wasn't clear enough to auto-confirm.",
  EMERGENCY_CONTENT: "The customer's message may describe a medical emergency — flagged immediately rather than answered automatically.",
  SUITABILITY_QUESTION: "The customer asked something needing individual medical/suitability judgment (e.g. \"is this safe for me\") — not something to answer generically.",
  MEDICAL_CONTENT: "The customer asked a clinical/medical question outside what's safe to answer automatically.",
  SIDE_EFFECT_REPORT: "The customer described side effects on their current medication (nausea, vomiting, or diarrhea) — Alexis gave them general options to discuss with the doctor, but a person should follow up to make sure they're doing okay.",
  PRESCRIPTION_QUESTION: "The customer asked something about their specific prescription needing individual judgment — not something to answer generically.",
  PAUSE_PRESCRIPTION_REQUEST: "The customer asked to pause, hold, or skip their prescription/order — pointed to the patient portal, but nothing was actually paused, so a person needs to follow up.",
  LEGAL_CONTENT: "The customer mentioned something legal (e.g. a threat to sue) — needs a person to handle directly.",
  PROHIBITED_CLINICAL:
    "Alexis's reply used a clinical word without its normally-required citation, and kept failing that check after several retries — her own reply was sent anyway rather than substituting something worse or going silent, but a person should double-check it.",
  QUESTION_MARK_IN_REPLY:
    "Alexis's reply kept putting a question mark in the wrong field even after retries — her own reply was sent anyway rather than going silent, but a person should glance at how it reads.",
  MISSING_NEXT_QUESTION:
    "Alexis's reply kept missing its required follow-up question even after retries — sent anyway as a plain reply with no question, rather than going silent.",
  INVALID_NEXT_QUESTION:
    "Alexis's follow-up question kept coming out malformed even after retries — sent anyway as drafted, rather than going silent.",
  UNEXPECTED_NEXT_QUESTION:
    "Alexis kept including a follow-up question when this turn didn't call for one, even after retries — sent anyway as drafted, rather than going silent.",
  REPEATED_DRAFT:
    "Alexis kept repeating her exact previous reply even after retries — sent anyway rather than going silent, but a person should check whether the conversation is actually stuck.",
};

export function describeNeedsAttentionReason(source: NeedsAttentionSource): string {
  switch (source.kind) {
    case "exception":
      return "An unexpected system error stopped a reply from being generated or sent — the customer got nothing.";
    case "rejected":
      return REJECTED_REASONS[source.code] ?? `The draft reply was rejected by an automatic check (${source.code}) and nothing was sent.`;
    case "staff_flagged":
      return source.preCheckCode
        ? (STAFF_FLAGGED_REASONS[source.preCheckCode] ?? `Flagged for a person to review (${source.preCheckCode}).`)
        : AI_DIDNT_UNDERSTAND_REASON;
    case "stuck_repeating":
      return "The bot kept asking essentially the same question. The repeated question was withheld; only an independently approved, useful answer may have been submitted. Check message delivery and the latest customer request. Further automated replies are paused for staff review.";
  }
}
