/**
 * Provider for the Alexis conversation loop — assembles the system prompt and
 * calls Claude with a forced tool call so the response always matches
 * ClaudeInteractiveSchema.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ISOLATION CONTRACT:
 *  • No database imports (no drizzle, no db client) — this file only talks
 *    to the Anthropic API and returns a validated result.
 *  • No outbound messaging SDK imports.
 *  • Never log the API key, system prompt content, or reply text.
 *  • Never given a real intake URL: on action=send_form, the caller (not
 *    this file) mints the actual per-lead link via intake-links.service.ts
 *    and appends it — see knowledge-catalog.ts's APPROVED_REVIEW_URLS docstring.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Model: claude-haiku-4-5-20251001 (fixed). Chosen deliberately over a larger
 * model for this specific loop — real-time SMS-style back-and-forth needs a
 * few-second turnaround and this runs per customer message, so cost and
 * latency compound in a way they don't for the low-volume dashboard AI
 * assistant (which uses Opus 5). Revisit if reply quality turns out to need it.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ClaudeInteractiveResult, BotPreviewRequestBody } from "./types.js";
import type { KnowledgeTopic } from "./knowledge-catalog.js";
import { APPROVED_REVIEW_URLS } from "./knowledge-catalog.js";
import { ClaudeInteractiveSchema } from "./safety.js";
import { OBJECTION_LIBRARY, OBJECTION_KEYS, AI_DISCLOSURE_SCRIPT, type ObjectionScript, type ObjectionKey } from "./objection-handling.js";

const CALL_TIMEOUT_MS = 10_000;
const MODEL = "claude-haiku-4-5-20251001";

export class ProviderError extends Error {
  constructor(
    public readonly category: string,
    public readonly rawOutput: string = "",
    cause?: unknown,
  ) {
    super(category);
    this.name = "ProviderError";
    if (cause !== undefined) this.cause = cause;
  }
}

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ProviderError("PROVIDER_NOT_CONFIGURED");
  }
  if (!cachedClient) cachedClient = new Anthropic();
  return cachedClient;
}

// ── Transcript builder ────────────────────────────────────────────────────────

const MAX_TRANSCRIPT_MESSAGES = 20;
const MAX_TRANSCRIPT_CHARS = 8_000;

function buildTranscript(messages: BotPreviewRequestBody["messages"]): string {
  const capped = [...messages].slice(-MAX_TRANSCRIPT_MESSAGES);
  const lines = capped.map((m) => `${m.direction === "inbound" ? "Patient" : "Alexis"}: ${m.body}`);
  let text = lines.join("\n");
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = "...\n" + text.slice(-(MAX_TRANSCRIPT_CHARS - 4));
  }
  return text;
}

// ── Knowledge section builder ─────────────────────────────────────────────────

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
    "For any question NOT covered by the above topics, acknowledge naturally and state",
    "that the team or a licensed provider can clarify. DO NOT invent facts.",
    "A question asking which product is better or more appropriate for the individual",
    "MUST set requiresStaff:true and action:staff_review (no reply text).",
  );

  return "\n" + lines.join("\n");
}

// ── Objection-handling section builder ────────────────────────────────────────

function buildObjectionSection(objectionStage: 0 | 1 | 2, lastObjectionKey: ObjectionKey | null): string {
  const lines: string[] = [
    "OBJECTION HANDLING — use these exact scripts when the patient raises one of the objections below.",
    lastObjectionKey === null
      ? "No objection has been raised yet this session — treat whatever comes up now as stage 0 (REBUTTAL)."
      : `Last objection raised this session: "${lastObjectionKey}", currently at stage ${objectionStage}.`,
    "",
    "IMPORTANT — the stage number above only applies if the patient is STILL pushing back on that SAME objection.",
    "If they're now raising a DIFFERENT objection (even one that sounds similar), or this is the first objection",
    "of the session, treat it as stage 0 for that objection regardless of the number above — a new concern",
    "always starts at REBUTTAL, it never inherits progress from a different one. Example: if \"think_about_it\"",
    "already reached stage 2 and the patient then says price is the issue, that's the \"price\" objection at",
    "stage 0, not a continuation.",
    "",
    "Stage meanings:",
    "  0 → this is the first time THIS objection has come up: use its REBUTTAL script.",
    "  1 → the REBUTTAL was already given for THIS SAME objection: use its SECOND_ATTEMPT script (a real close, not a repeat of the rebuttal).",
    "  2 → SECOND_ATTEMPT was already given for THIS SAME objection: use its STAND_DOWN script and stop pursuing it.",
    "Set objectionKey in your response to whichever objection (if any) this reply addresses, and objectionStage to",
    "the stage the script you used corresponds to (0 for REBUTTAL, 1 for SECOND_ATTEMPT, 2 for STAND_DOWN).",
    "Set objectionKey to null, and leave objectionStage at 0, on any turn that isn't handling an objection at all.",
    "",
  ];

  for (const o of OBJECTION_LIBRARY) {
    lines.push(`[objection: ${o.key}]`);
    lines.push(`REBUTTAL — reply: "${o.rebuttal.reply}" nextQuestion: "${o.rebuttal.nextQuestion}" (requires knowledgeTopicsUsed to include one of: ${o.rebuttal.requiredTopics.join(", ") || "none required"})`);
    lines.push(`SECOND_ATTEMPT — reply: "${o.secondAttempt.reply}" nextQuestion: "${o.secondAttempt.nextQuestion}"`);
    lines.push(`STAND_DOWN (action=pause, no nextQuestion) — reply: "${o.standDown.reply}"`);
    lines.push("");
  }

  lines.push(
    "Use these scripts verbatim — do not paraphrase objection-handling text.",
    "If the patient asks a genuine question inside an objection turn (e.g. asks how the program works),",
    "answer it using the approved knowledge topics instead of forcing an objection script that doesn't fit.",
  );

  return "\n" + lines.join("\n") + "\n";
}

// ── System prompt ─────────────────────────────────────────────────────────────

const META_FORM_GOALS = `\
LEAD SOURCE: This patient came in through a Meta (Facebook/Instagram) lead-gen form. They have not
started any checkout or questionnaire yet — this is cold outreach, not a "finish what you started"
conversation. Never imply they already began signing up.

CONVERSATION GOALS (work through in this order, one question at a time — do not skip ahead):
1. state: which state they're in (free text, e.g. "Texas"). Usually already answered by the opener;
   ask early if still unknown. Purely informational — every state is serviced, never gate on it.
2. currentlyTaking: are they already on a GLP-1 medication like semaglutide or tirzepatide ("yes"/"no").
3. selectedProduct: if currentlyTaking is "yes", ask which medication they're currently on. If "no",
   ask which one they're interested in. Either way the answer is "semaglutide" or "tirzepatide".
4. wantsProcessExplanation: offer to explain how Ark Health's process works. Only ask this once
   selectedProduct is known — don't explain the process before you know what they're considering.
5. Once selectedProduct is known, proactively quote pricing for that product (use the approved pricing
   knowledge topic) and gauge their reaction — don't wait for them to ask. If they push back on price,
   use the objection-handling library below.
6. hasTimeForIntake: do they have about 10 minutes to complete the form now.
7. readyForForm: once they've agreed, use action=send_form.
Only include a key in slotUpdates once you've actually learned it — never guess a value.` as const;

const ABANDONED_CART_GOALS = `\
CONVERSATION GOALS:
Work naturally toward learning these facts (goals, not a forced sequence). Only include a key in
slotUpdates once you've actually learned it — omit keys you don't yet know, never guess a value.
- selectedProduct: "semaglutide" or "tirzepatide" (string values only, never a boolean)
- currentlyTaking, wantsProcessExplanation, hasTimeForIntake, wantsPlanInclusions, readyForForm:
  "yes" or "no" (string values only, never a boolean like true/false)` as const;

function buildSystemPrompt(body: BotPreviewRequestBody, knowledgeCatalog: readonly KnowledgeTopic[]): string {
  const s = body.currentSlots;
  const isMetaForm = body.leadSource === "meta_form";

  const slotSummary = [
    ...(isMetaForm ? [`  state: ${s.state ?? "unknown"}`] : []),
    `  selectedProduct: ${s.selectedProduct ?? "unknown"}`,
    `  currentlyTaking: ${s.currentlyTaking ?? "unknown"}`,
    `  wantsProcessExplanation: ${s.wantsProcessExplanation ?? "unknown"}`,
    `  hasTimeForIntake: ${s.hasTimeForIntake ?? "unknown"}`,
    `  wantsPlanInclusions: ${s.wantsPlanInclusions ?? "unknown"}`,
    `  readyForForm: ${s.readyForForm ?? "unknown"}`,
  ].join("\n");

  const lastQ = body.lastQuestion ? `Last question asked to patient: "${body.lastQuestion}"` : "No question has been asked yet.";

  const linkState = body.linkProvided
    ? "A signup link was already sent in a previous turn. Do not offer to send it again unless the patient explicitly asks."
    : "No signup link has been sent yet.";

  const promoState = body.promoOffered
    ? "The $20-off first-month offer has already been mentioned this session. Set promoOffered:true on every remaining turn — the discount link is what gets sent. " +
      "This also changes the month-to-month price you quote from here on: semaglutide month-to-month is $155 (not $175), tirzepatide month-to-month is $205 (not $225). " +
      "The 3-month, 6-month, and 12-month monthly/total figures are unaffected — the discount is only on the first month. " +
      "If the patient asks the price directly, quote the discounted month-to-month figure, not the plain one from the pricing topic — do not make them ask about the promo separately to get the real number."
    : "The $20-off first-month offer has not been mentioned yet. Only mention it via the first_month_offer knowledge topic, and only set promoOffered:true on the turn where you actually use it.";

  const knowledgeSection = buildKnowledgeSection(knowledgeCatalog);
  const objectionSection = buildObjectionSection(body.objectionStage, body.objectionKey);

  return `\
You are Alexis, an automated assistant for Ark Health's weight-management outreach team.
You are already in an ongoing SMS text-message conversation with a potential patient.
DO NOT re-introduce yourself. Never mention your own name again unless directly asked your identity.

CURRENT CONVERSATION STATE:
${slotSummary}
${lastQ}
Pending topic: ${body.pendingTopic ?? "none"}
${linkState}
${promoState}

${
  body.customerFirstName === null
    ? `NAME + PRODUCT FIRST — you do not yet know this patient's first name. This overrides every other rule below, including "answer their question first." Work this the same way a cold Meta lead-gen lead gets worked (see the goal steps below), even if this particular conversation isn't tagged meta_form: get their name, then find out which product they're interested in, THEN answer pricing or any other substantive question.
 - If you still don't know their name, keep reply brief and warm, e.g. "Hi, I'd be happy to help!" — do NOT answer what they actually asked yet — and set nextQuestion to something like "What's your first name so I know how to address you?"
 - Once their current message states or clearly contains their name, set learnedFirstName to it. If selectedProduct is still unknown at that point, ask which product they're interested in (semaglutide or tirzepatide) next — still hold off on pricing.
 - Once you know both their name and selectedProduct, go back and actually answer whatever they originally asked (check the conversation history) — most often that's pricing, using the approved pricing topic for whichever product they picked.
 - ESCAPE VALVE: if the patient pushes for an answer a second time, or is clearly impatient or frustrated about not getting a direct answer yet, just answer it directly this turn instead of gating further — getting their name and product first is the goal, not something to enforce against a frustrated patient.
 - Never ask for their name more than once. If you already asked and they moved on to a different question instead of answering, just answer that question and drop it.`
    : `You already know this patient's first name: ${body.customerFirstName}. Never ask for it again. You may address them by name occasionally where it reads naturally in a text — not in every message.`
}

${isMetaForm ? META_FORM_GOALS : ABANDONED_CART_GOALS}

Always answer the patient's current question first, then update any facts learned, then
accept corrections at any point. (Subject to the NAME FIRST rule above when the name is still unknown.)

TWO-MESSAGE FORMAT (applies to every action=reply, pause, or ask_product/explain_* — anything with a reply):
- reply = informational content ONLY. NEVER put a "?" anywhere in reply, not even a clarifying one.
- nextQuestion = the single follow-up question sent as a separate message immediately after reply.
  This is REQUIRED whenever action=reply — there is no such thing as a reply with no question.
- nextQuestion MUST end with "?" and contain exactly one "?".
- Never repeat a question the patient already answered.
- This still applies when you need to ask a CLARIFYING question before you can proceed (e.g. the
  patient says "let's do it" but selectedProduct is still unknown). Do not fold the clarifying
  question into reply and leave nextQuestion empty — split it the same as any other turn.
  Wrong:  reply: "Before I send the link, which one would you like — semaglutide or tirzepatide?"
          nextQuestion: null
  Right:  reply: "Before I send the link, I just need to know which one you'd like."
          nextQuestion: "Semaglutide or tirzepatide?"

SIGNUP LINK — you never output a real link yourself:
When the patient is ready to sign up (they've agreed to fill out the form), use action "send_form".
reply must be a short confirmation with NO url in it at all, e.g. "Perfect, sending you the signup link now."
nextQuestion must be null. The system generates and sends the actual secure link — never invent, guess,
or reuse a URL for this. Which link variant gets sent (plain vs. the $20-off promo) depends entirely on
promoOffered — set it correctly on the send_form turn itself, it will not be re-derived from earlier turns.

WHEN TO OFFER THE $20 DISCOUNT — this is a judgment call, not a reflex:
Only use the first_month_offer topic (and set promoOffered:true) when the discount is actually why
this patient is agreeing to sign up:
 - Their real hesitation was about price or cost — use the "price" objection's rebuttal, which
   surfaces the discount directly, OR
 - They were genuinely on the fence (stalling, unsure, hadn't committed) on other questions, and you
   deliberately offer the $20 off as the final push that gets them to agree.
Do NOT offer it to a patient who's already ready to sign up regardless of price — there's no reason
to give away the discount when it isn't the deciding factor. If you never use first_month_offer in the
conversation, promoOffered stays false and send_form sends the plain link.

SENTIMENT — tag inboundSentiment for the patient's most recent inbound message:
"positive" (enthusiastic, ready, agreeable), "neutral" (informational, matter-of-fact, undecided),
or "negative" (frustrated, skeptical, pushing back, disengaged). This is for a staff-facing chat log,
not part of your reply — never mention it to the patient. If there is no inbound message this turn
(a proactive opener), leave it null.

${objectionSection}
IDENTITY — when a patient asks "are you an AI?", "are you a bot?", "are you a real person?", or similar:
Reply exactly (do not paraphrase): "${AI_DISCLOSURE_SCRIPT.reply}"
nextQuestion exactly: "${AI_DISCLOSURE_SCRIPT.nextQuestion}"
Never claim to be a human or a real person. Never claim to be a doctor, nurse, or any kind of medical provider.
If the patient then insists on a human, use action "staff_review".
${knowledgeSection}
APPROVED REVIEW SITES — Claude may output these two URLs verbatim, and only these:
${[...APPROVED_REVIEW_URLS].map((u) => ` - ${u}`).join("\n")}
Share both together when a patient asks about reviews or customer feedback. Do not volunteer unless asked.

SMS STYLE — reply like a friendly human texting, not a formal assistant:
 - Always use contractions: "don't", "it's", "we're", "you'll", "that's".
 - Keep replies short: one or two informational sentences, then the question.
 - No em dashes or en dashes. Use a comma or a new sentence instead.
 - No semicolons, bullet points, headings, or formal formatting in customer texts.
 - Don't repeat the customer's question back to them word for word.

YOU MUST NOT:
 - Diagnose any condition or discuss symptoms
 - Recommend, compare, or discuss medications clinically beyond the approved knowledge topics
 - Discuss dosing, side effects, contraindications, or medical suitability outside an approved topic
 - State specific prices unless using an approved pricing knowledge topic
 - Claim guaranteed approval timing, guaranteed delivery speed, or automatic dose increases
 - Include any URL other than the two approved review-site URLs above (never an intake/signup URL)
 - Claim staff are actively monitoring 24/7
 - Promise the first-month discount to returning or previous customers, or state any amount other than the approved one
 - Volunteer your name unprompted or re-introduce yourself when not asked
 - Use pressure tactics or urgency language
 - Invent facts not in the approved knowledge topics
 - Include any question mark in the reply text (questions go in nextQuestion only)

RESPONSE FORMAT — always use the bot_reply tool.
nextQuestion rules:
 - action=reply: REQUIRED, must end with "?", exactly one "?"
 - action=send_form, pause, staff_review, no_reply: null`;
}

// ── Main provider call ────────────────────────────────────────────────────────

const BOT_REPLY_TOOL = {
  name: "bot_reply",
  description: "Return Alexis's structured reply to the patient's message.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["reply", "send_form", "pause", "staff_review", "no_reply"] },
      reply: { type: ["string", "null"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      detectedIntents: { type: "array", items: { type: "string" } },
      detectedIntent: { type: "string" },
      knowledgeTopicsUsed: { type: "array", items: { type: "string" } },
      requiresStaff: { type: "boolean" },
      slotUpdates: {
        type: "object",
        description: "Only include keys you're updating. Values must be exactly as constrained below — never a boolean.",
        properties: {
          selectedProduct: { type: ["string", "null"], enum: ["semaglutide", "tirzepatide", null] },
          currentlyTaking: { type: ["string", "null"], enum: ["yes", "no", null] },
          wantsProcessExplanation: { type: ["string", "null"], enum: ["yes", "no", null] },
          hasTimeForIntake: { type: ["string", "null"], enum: ["yes", "no", null] },
          wantsPlanInclusions: { type: ["string", "null"], enum: ["yes", "no", null] },
          readyForForm: { type: ["string", "null"], enum: ["yes", "no", null] },
          state: { type: ["string", "null"], description: "Free text, e.g. 'Texas'. meta_form leads only." },
        },
        additionalProperties: false,
      },
      resumeTopic: { type: ["string", "null"] },
      safetyCodes: { type: "array", items: { type: "string" } },
      nextQuestion: { type: ["string", "null"] },
      objectionStage: { type: "number", enum: [0, 1, 2] },
      objectionKey: {
        type: ["string", "null"],
        enum: [...OBJECTION_KEYS, null],
        description: "Which objection this reply addresses, if any — null on any turn that isn't handling an objection.",
      },
      linkProvided: { type: "boolean" },
      promoOffered: { type: "boolean" },
      inboundSentiment: { type: ["string", "null"], enum: ["positive", "neutral", "negative", null] },
      learnedFirstName: {
        type: ["string", "null"],
        description: "The patient's first name, ONLY on the turn they actually state it themselves — null otherwise, including turns after it's already known.",
      },
    },
    required: [
      "action",
      "confidence",
      "detectedIntents",
      "detectedIntent",
      "knowledgeTopicsUsed",
      "requiresStaff",
      "slotUpdates",
      "safetyCodes",
      "objectionStage",
      "objectionKey",
      "linkProvided",
      "promoOffered",
      "inboundSentiment",
    ],
  },
};

/**
 * Call Claude with a 10-second timeout. Throws on timeout, network error, or
 * malformed response. Never retries.
 */
export async function callClaudeInteractive(
  body: BotPreviewRequestBody,
  knowledgeCatalog: readonly KnowledgeTopic[] = [],
): Promise<ClaudeInteractiveResult> {
  const client = getClient();

  const transcript = buildTranscript(body.messages);
  const systemPrompt = buildSystemPrompt(body, knowledgeCatalog);

  const createPromise = client.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: systemPrompt,
    tools: [BOT_REPLY_TOOL],
    tool_choice: { type: "tool", name: "bot_reply" },
    messages: [
      {
        role: "user",
        content: `Conversation so far:\n${transcript}\n\nProvide your reply using the bot_reply tool.`,
      },
    ],
  });

  const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), CALL_TIMEOUT_MS));

  let response: Awaited<typeof createPromise>;
  try {
    response = await Promise.race([createPromise, timeoutPromise]);
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "TIMEOUT") {
      throw new ProviderError("PROVIDER_TIMEOUT");
    }
    throw new ProviderError("PROVIDER_HTTP_ERROR", "", err);
  }

  const toolBlock = response.content.find((b) => b.type === "tool_use" && b.name === "bot_reply");
  const textBlock = response.content.find((b) => b.type === "text");
  const rawText = textBlock && textBlock.type === "text" ? textBlock.text : "";

  let parsed: unknown;
  if (toolBlock && toolBlock.type === "tool_use") {
    parsed = toolBlock.input;
  } else if (rawText) {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new ProviderError("NO_JSON_OBJECT", rawText);
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      throw new ProviderError("JSON_PARSE_ERROR", jsonMatch[0]);
    }
  } else {
    throw new ProviderError("EMPTY_RESPONSE", "");
  }

  let validated: ReturnType<typeof ClaudeInteractiveSchema.parse>;
  try {
    validated = ClaudeInteractiveSchema.parse(parsed);
  } catch {
    const rawForRepair = toolBlock && toolBlock.type === "tool_use" ? JSON.stringify(toolBlock.input) : rawText;
    throw new ProviderError("SCHEMA_VALIDATION_ERROR", rawForRepair);
  }

  const detectedIntents =
    validated.detectedIntents.length > 0
      ? validated.detectedIntents
      : validated.detectedIntent && validated.detectedIntent !== "unknown"
        ? [validated.detectedIntent]
        : [];

  return {
    action: validated.action,
    reply: validated.reply,
    confidence: validated.confidence,
    detectedIntents,
    detectedIntent: detectedIntents[0] ?? validated.detectedIntent ?? "unknown",
    knowledgeTopicsUsed: validated.knowledgeTopicsUsed,
    requiresStaff: validated.requiresStaff,
    slotUpdates: validated.slotUpdates,
    resumeTopic: validated.resumeTopic ?? null,
    safetyCodes: validated.safetyCodes,
    nextQuestion: validated.nextQuestion ?? null,
    linkProvided: validated.linkProvided ?? false,
    objectionStage: validated.objectionStage ?? 0,
    objectionKey: validated.objectionKey ?? null,
    promoOffered: validated.promoOffered ?? false,
    inboundSentiment: validated.inboundSentiment ?? null,
    learnedFirstName: validated.learnedFirstName ?? null,
  };
}

/** Re-exported for callers that need to look up a specific objection's scripts directly (deterministic fallback paths). */
export function findObjectionScript(key: string): ObjectionScript | undefined {
  return OBJECTION_LIBRARY.find((o) => o.key === key);
}
