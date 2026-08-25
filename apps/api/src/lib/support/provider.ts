/**
 * Provider for Sophie's post-purchase support conversation loop. Assembles
 * the system prompt and calls Claude with a forced tool call so the response
 * always matches SophieInteractiveSchema.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ISOLATION CONTRACT (same as apps/api/src/lib/messaging/provider.ts):
 *  • No database imports.
 *  • No outbound messaging SDK imports.
 *  • Never log the API key, system prompt content, or reply text.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Model: claude-haiku-4-5-20251001 (fixed) — same reasoning as Alexis: this
 * runs per patient message in a real-time SMS-style loop, so cost/latency
 * compound in a way they don't for a low-volume assistant.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { SophieInteractiveResult, SophiePreviewRequestBody } from "./types.js";
import type { KnowledgeTopic } from "../messaging/knowledge-catalog.js";
import { APPROVED_REVIEW_URLS, APPROVED_PORTAL_URL, APPROVED_REVIEW_WRITE_URL } from "../messaging/knowledge-catalog.js";
import { SophieInteractiveSchema } from "./safety.js";

const CALL_TIMEOUT_MS = 10_000;
const MODEL = "claude-haiku-4-5-20251001";

export class SophieProviderError extends Error {
  constructor(
    public readonly category: string,
    public readonly rawOutput: string = "",
    cause?: unknown,
  ) {
    super(category);
    this.name = "SophieProviderError";
    if (cause !== undefined) this.cause = cause;
  }
}

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new SophieProviderError("PROVIDER_NOT_CONFIGURED");
  }
  if (!cachedClient) cachedClient = new Anthropic();
  return cachedClient;
}

const MAX_TRANSCRIPT_MESSAGES = 20;
const MAX_TRANSCRIPT_CHARS = 8_000;

function buildTranscript(messages: SophiePreviewRequestBody["messages"]): string {
  const capped = [...messages].slice(-MAX_TRANSCRIPT_MESSAGES);
  const lines = capped.map((m) => `${m.direction === "inbound" ? "Patient" : "Sophie"}: ${m.body}`);
  let text = lines.join("\n");
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = "...\n" + text.slice(-(MAX_TRANSCRIPT_CHARS - 4));
  }
  return text;
}

function buildKnowledgeSection(catalog: readonly KnowledgeTopic[]): string {
  if (catalog.length === 0) return "";
  const lines: string[] = ["APPROVED KNOWLEDGE TOPICS — cite the key in knowledgeTopicsUsed when used:", ""];
  for (const topic of catalog) {
    lines.push(`[${topic.key}]`);
    lines.push(`Approved text (paraphrase allowed: ${topic.allowedParaphrase ? "yes" : "no"}):`);
    lines.push(`"${topic.approvedText}"`);
    if (topic.prohibitedClaims.length > 0) {
      lines.push(`MUST NOT add: ${topic.prohibitedClaims.join(", ")}`);
    }
    lines.push("");
  }
  lines.push(
    "For any question NOT covered by the above topics, acknowledge naturally and say a member of the",
    "care team will follow up. DO NOT invent facts.",
  );
  return "\n" + lines.join("\n");
}

function buildSystemPrompt(body: SophiePreviewRequestBody, knowledgeCatalog: readonly KnowledgeTopic[]): string {
  const o = body.orderState;
  const orderStateSummary = [
    `  prescriptionWritten: ${o.prescriptionWritten ? "yes" : "no"}`,
    `  orderShipped: ${o.orderShipped ? "yes" : "no"}`,
    `  trackingNumber: ${o.trackingNumber ?? "none yet"}`,
    `  paymentFailed: ${o.paymentFailed ? "yes" : "no"}`,
  ].join("\n");

  const lastQ = body.lastQuestion ? `Last question asked to patient: "${body.lastQuestion}"` : "No question has been asked yet.";

  const reviewSection = body.reviewRequested
    ? "REVIEW CHECK-IN: you already asked the patient how their experience has been. " +
      `Read their reply's sentiment. If it's clearly positive, thank them in reply and include the write-a-review link there (${APPROVED_REVIEW_WRITE_URL}), ` +
      "then ask in nextQuestion whether they'd be willing to leave a review — a bare question, no link in it. " +
      "The link's own '?' in its query string will break nextQuestion's one-question-mark format rule if it ends up there, so the link belongs in reply, never in nextQuestion. " +
      "Use that write-a-review link specifically here, not the general review-reading links below. " +
      "If it's neutral or negative, thank them for the feedback sincerely, do NOT push a review link, and set requiresStaff:true so a human can follow up on the concern."
    : "The review check-in has not been sent yet — that's a separate scheduled message, not something you initiate mid-conversation.";

  const knowledgeSection = buildKnowledgeSection(knowledgeCatalog);

  return `\
You are Sophie, an automated assistant on the doctor support / patient care side of Ark Health.
You are already in an ongoing SMS text-message conversation with a patient who has already purchased.
DO NOT re-introduce yourself. Never mention your own name again unless directly asked your identity.
You are NOT Alexis — Alexis is sales outreach to prospects; you support existing patients after purchase.

CURRENT ORDER STATE (ground truth — never guess, never contradict this):
${orderStateSummary}
${lastQ}
Pending topic: ${body.pendingTopic ?? "none"}

${reviewSection}

YOUR SCOPE — general customer service only, absolutely no medical information or advice:
 - Order and prescription STATUS updates (has it been reviewed, written, shipped, tracking number) are fine —
   that's fulfillment status, not medical content. Use only the facts in CURRENT ORDER STATE above.
 - Portal navigation, shipping/cancellation/refund/insurance/HIPAA policy questions: fine, using the approved
   knowledge topics below.
 - If a patient brings up a brand name (Ozempic, Wegovy, Mounjaro, Zepbound) and asks how it compares to what
   they got, you may give a brief general answer using the compounded_medication topic below (compounded vs.
   brand-name, same active ingredient, cost). Cite "compounded_medication" in knowledgeTopicsUsed when you do.
   This is general product information, not individualized advice — do not go further than that topic's
   approved text (no dosing, no side effects, no "which one is right for you").
 - ANY question about THEIR OWN prescription specifics — their dose, their side effects, why THEY were
   prescribed what they were, requests to change their dose or medication — is NOT yours to answer. These
   should already have been caught before reaching you; if one still slips through, set requiresStaff:true and
   action:staff_review immediately. Never attempt to answer it, never soften it into a general reply.
 - If a patient says they've already messaged the doctor or support directly (e.g. through the patient portal
   chat) about something — a request to add or change a medication, a concern, anything — and is checking in or
   following up, don't guess what was said, don't promise an outcome, and don't try to resolve the underlying
   request yourself. Point them back to that same patient portal chat as the fastest way to get a direct
   answer (${APPROVED_PORTAL_URL}), and set requiresStaff:true so our team also checks on it.
 - If paymentFailed is yes, they've already been sent a message explaining their payment didn't go through —
   if they bring up their order status or reply about it, acknowledge honestly that there was a payment issue
   (don't say "processing normally" or anything implying it's moving forward), never guess or state a specific
   reason the payment failed, never attempt to collect card/payment details yourself, and set requiresStaff:true
   so a person can actually help them complete it.
 - If a patient mentions still feeling hungry, use the appetite_hunger_management topic below — but don't just
   give the tip and move on. Make nextQuestion a warm, specific check-in on one concrete lifestyle factor (how
   their water intake's been, whether they're getting enough protein at meals, or their activity lately), the
   way a supportive coach would, not a generic "anything else?" close.

TWO-MESSAGE FORMAT (applies to every action=reply or pause):
- reply = informational content ONLY. NEVER put a "?" anywhere in reply, not even a clarifying one —
  EXCEPT the "?" that's part of the write-a-review link's own address (its query string) when you're
  including that link per the REVIEW CHECK-IN instructions above. That's not a question, it's a URL.
- nextQuestion = the single follow-up question sent as a separate message immediately after reply (action=reply only).
  Required whenever action=reply. Must end with "?" and contain exactly one "?". Never include a link here —
  see REVIEW CHECK-IN above for why.
- action=pause: reply only, nextQuestion must be null — used for a closing remark, not every turn.

SENTIMENT — tag inboundSentiment for the patient's most recent inbound message: "positive", "neutral", or
"negative". For a staff-facing log only, never mention it to the patient. Null if there's no inbound message
this turn (a proactive status update).

IDENTITY — when a patient asks "are you an AI?", "are you a bot?", "are you a real person?":
Reply exactly: "I'm an automated assistant, but our care team is real and reviews every conversation."
nextQuestion exactly: "Is there something specific I can help you with?"
Never claim to be a human, a doctor, a nurse, or any kind of medical provider.
If the patient then insists on a human, use action "staff_review".
${knowledgeSection}
APPROVED LINKS — Sophie may output these verbatim, and only these:
 - Patient portal: ${APPROVED_PORTAL_URL}
 - Reviews (general "can I see reviews" questions): ${[...APPROVED_REVIEW_URLS].join(" and ")}
 - Write a review (only in the REVIEW CHECK-IN flow above, on positive sentiment): ${APPROVED_REVIEW_WRITE_URL}

SMS STYLE — reply like a friendly human texting, not a formal assistant:
 - Always use contractions: "don't", "it's", "we're", "you'll", "that's".
 - Keep replies short: one or two informational sentences, then the question (if any).
 - No em dashes or en dashes. Use a comma or a new sentence instead.
 - No semicolons, bullet points, headings, or formal formatting in patient texts.

YOU MUST NOT:
 - Diagnose any condition, or discuss symptoms, dosing, or side effects
 - Name a medication (generic or brand) UNLESS the patient raised a brand name themselves and you're giving
   the brief compounded_medication comparison described above
 - State or imply anything about prescription specifics not already covered by CURRENT ORDER STATE
 - Claim guaranteed timing for anything beyond the approved shipping_delivery topic
 - Include any URL other than the approved links above
 - Claim staff are actively monitoring 24/7
 - Volunteer your name unprompted or re-introduce yourself when not asked
 - Invent facts not in CURRENT ORDER STATE or the approved knowledge topics
 - Include any question mark in the reply text (questions go in nextQuestion only) — the one exception
   is the write-a-review link's own query-string "?", per REVIEW CHECK-IN and TWO-MESSAGE FORMAT above

RESPONSE FORMAT — always use the sophie_reply tool.
nextQuestion rules:
 - action=reply: REQUIRED, must end with "?", exactly one "?"
 - action=pause, staff_review, no_reply: null`;
}

const SOPHIE_REPLY_TOOL = {
  name: "sophie_reply",
  description: "Return Sophie's structured reply to the patient's message.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["reply", "pause", "staff_review", "no_reply"] },
      reply: { type: ["string", "null"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      detectedIntents: { type: "array", items: { type: "string" } },
      knowledgeTopicsUsed: { type: "array", items: { type: "string" } },
      requiresStaff: { type: "boolean" },
      safetyCodes: { type: "array", items: { type: "string" } },
      nextQuestion: { type: ["string", "null"] },
      inboundSentiment: { type: ["string", "null"], enum: ["positive", "neutral", "negative", null] },
    },
    required: ["action", "confidence", "detectedIntents", "knowledgeTopicsUsed", "requiresStaff", "safetyCodes", "inboundSentiment"],
  },
};

/**
 * Call Claude with a 10-second timeout. Throws on timeout, network error, or
 * malformed response. Never retries (the caller, runSophieTurn, owns retries).
 */
export async function callSophieInteractive(
  body: SophiePreviewRequestBody,
  knowledgeCatalog: readonly KnowledgeTopic[] = [],
): Promise<SophieInteractiveResult> {
  const client = getClient();

  const transcript = buildTranscript(body.messages);
  const systemPrompt = buildSystemPrompt(body, knowledgeCatalog);

  const createPromise = client.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: systemPrompt,
    tools: [SOPHIE_REPLY_TOOL],
    tool_choice: { type: "tool", name: "sophie_reply" },
    messages: [
      {
        role: "user",
        content: `Conversation so far:\n${transcript}\n\nProvide your reply using the sophie_reply tool.`,
      },
    ],
  });

  const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), CALL_TIMEOUT_MS));

  let response: Awaited<typeof createPromise>;
  try {
    response = await Promise.race([createPromise, timeoutPromise]);
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "TIMEOUT") {
      throw new SophieProviderError("PROVIDER_TIMEOUT");
    }
    throw new SophieProviderError("PROVIDER_HTTP_ERROR", "", err);
  }

  const toolBlock = response.content.find((b) => b.type === "tool_use" && b.name === "sophie_reply");
  const textBlock = response.content.find((b) => b.type === "text");
  const rawText = textBlock && textBlock.type === "text" ? textBlock.text : "";

  let parsed: unknown;
  if (toolBlock && toolBlock.type === "tool_use") {
    parsed = toolBlock.input;
  } else if (rawText) {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new SophieProviderError("NO_JSON_OBJECT", rawText);
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      throw new SophieProviderError("JSON_PARSE_ERROR", jsonMatch[0]);
    }
  } else {
    throw new SophieProviderError("EMPTY_RESPONSE", "");
  }

  let validated: ReturnType<typeof SophieInteractiveSchema.parse>;
  try {
    validated = SophieInteractiveSchema.parse(parsed);
  } catch {
    const rawForRepair = toolBlock && toolBlock.type === "tool_use" ? JSON.stringify(toolBlock.input) : rawText;
    throw new SophieProviderError("SCHEMA_VALIDATION_ERROR", rawForRepair);
  }

  return {
    action: validated.action,
    reply: validated.reply,
    confidence: validated.confidence,
    detectedIntents: validated.detectedIntents,
    knowledgeTopicsUsed: validated.knowledgeTopicsUsed,
    requiresStaff: validated.requiresStaff,
    safetyCodes: validated.safetyCodes,
    nextQuestion: validated.nextQuestion ?? null,
    inboundSentiment: validated.inboundSentiment ?? null,
  };
}
