import Anthropic from "@anthropic-ai/sdk";
import { eq, sql } from "drizzle-orm";
import { db, customersTable, supportConversationsTable, unmatchedSmsThreadsTable, unmatchedSmsMessagesTable, type UnmatchedSmsThread, type UnmatchedSmsMessage } from "@luma/db";
import { getSmsProvider } from "../lib/sms-provider.js";
import { normalizePhone } from "../lib/phone.js";
import { processInboundMessage } from "./alexis-dispatch.service.js";
import { processInboundSupportMessage } from "./sophie-dispatch.service.js";
import { getOrCreateConversation, appendMessage } from "./conversations.service.js";
import { getOrCreateSupportConversation, appendSupportMessage } from "./support-conversations.service.js";
import { logger } from "../lib/logger.js";

/**
 * SMS twin of unmatched-inbound-email.service.ts. What used to happen to a
 * text from a phone number matching no customer record: logged and silently
 * dropped, invisible to staff (see the identical "unrecognized phone number"
 * log line this replaces in iblusend-webhook.service.ts). This records it
 * instead, grouped into one thread per phone number, with a Claude-drafted
 * classification and reply attached.
 *
 * Auto-sent by default: the fixed first-message ack, and every
 * classification-drafted reply after it, go out immediately with no human
 * in the loop — the safety rail is Claude's own needsHumanReview flag (set
 * when it's genuinely unsure, or for an individualized medical/suitability
 * question) plus two hard overrides this file applies regardless of what
 * Claude reports: a plausible match to an existing customer, or a sender
 * claiming to already have an account. Only those cases sit in the
 * dashboard queue for a person to review before anything sends — except
 * one: when the texted name AND the collected email both point at the
 * exact same existing customer (see findAutoConnectCustomerId), that's
 * unambiguous enough to skip review entirely and route straight into
 * their real conversation, no lead created.
 *
 * The one real difference from the email version: a text never comes with
 * an email address attached, and customers.email is NOT NULL, so a lead
 * can't be auto-created off a name alone the way it can from an unmatched
 * email sender. Both a name AND an email have to be gathered from the
 * conversation first — collectedEmail on the thread holds that once
 * Claude extracts it, separately from linkedCustomerId (set once the lead
 * actually exists).
 *
 * The moment a lead is created (name + email both known, Claude confident
 * this is a genuine prospective customer, not spam), the triggering message
 * is handed off to Alexis's real, guardrailed pipeline (processInboundMessage)
 * as a Meta-lead-style conversation — same trust level every other
 * unattended lead-capture path in this app already operates at.
 */

const MODEL = "claude-haiku-4-5-20251001";
const CALL_TIMEOUT_MS = 10_000;
const MAX_TRANSCRIPT_CHARS = 6_000;
const MAX_TRANSCRIPT_MESSAGES = 10;

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }
  if (!cachedClient) cachedClient = new Anthropic();
  return cachedClient;
}

interface MatchCandidate {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
}

/**
 * Same conservative substring match as unmatched-inbound-email.service.ts's
 * findMatchCandidates — a candidate only qualifies if both their first and
 * last name literally appear in what we know about this sender (their
 * texted name, if given, plus the transcript). Deliberately narrow: a false
 * positive here means suggesting the wrong person on a health-context
 * thread, worse than staff having to search manually for a real match.
 *
 * This is the name-based, Claude-reviewed "possibly this person" suggestion
 * shown to staff — see findExistingCustomerByEmail below for a separate,
 * deterministic exact-email check that guards lead creation directly rather
 * than relying on Claude to notice a match.
 */
async function findMatchCandidates(fromName: string | null, transcriptText: string): Promise<MatchCandidate[]> {
  const searchText = `${fromName ?? ""} ${transcriptText}`.trim();
  if (!searchText) return [];

  const { rows } = await db.execute<{ id: string; firstName: string; lastName: string; email: string }>(sql`
    select id, first_name as "firstName", last_name as "lastName", email
    from customers
    where length(first_name) > 1
      and length(last_name) > 1
      and ${searchText} ilike '%' || first_name || '%'
      and ${searchText} ilike '%' || last_name || '%'
    limit 5
  `);
  return rows;
}

/**
 * Exact (case-insensitive) email match against every customer — unlike the
 * email pipeline, where the sender's address was already checked against
 * every customer before the message ever reached this file, an SMS
 * sender's collected email is new information the original phone-based
 * lookup never saw. Deliberately a separate, deterministic check from
 * findMatchCandidates rather than folded into Claude's own
 * matchCandidateIndex judgment: this runs right before lead creation
 * (after classification has had a chance to extract the email this same
 * turn), so it catches a same-turn collision that a candidate search run
 * before classification would miss, and it doesn't depend on Claude
 * noticing the match at all — an exact email is unambiguous enough not to
 * need a judgment call.
 *
 * customers.email has no database-level uniqueness constraint, so more
 * than one customer can technically share an address (a stale duplicate
 * record, a shared household email, etc). This result feeds the
 * auto-connect and ask-to-confirm paths below, which act on the assumption
 * that an exact email means one specific, identified person — picking one
 * of several arbitrarily and treating it as certain would risk connecting
 * a text to the wrong person's health record and support history. So a
 * genuine collision comes back as `ambiguous: true` with no candidate at
 * all, distinct from no match found — callers must still treat that as a
 * reason to hold for human review (something real is going on with this
 * email), just never as license to auto-connect, suggest a specific
 * person, or ask a confirmation question about an identity we can't
 * actually pin down.
 */
async function findExistingCustomerByEmail(email: string): Promise<{ candidate: MatchCandidate | undefined; ambiguous: boolean }> {
  const { rows } = await db.execute<{ id: string; firstName: string; lastName: string; email: string }>(sql`
    select id, first_name as "firstName", last_name as "lastName", email
    from customers
    where lower(email) = lower(${email})
    limit 2
  `);
  if (rows.length > 1) return { candidate: undefined, ambiguous: true };
  return { candidate: rows[0], ambiguous: false };
}

interface Classification {
  readonly intent: "new_lead_interest" | "existing_customer_support" | "spam_or_irrelevant" | "other";
  readonly summary: string;
  readonly suggestedReply: string | null;
  readonly senderName: string | null;
  readonly senderEmail: string | null;
  readonly matchCandidateIndex: number | null;
  readonly matchConfidence: "high" | "medium" | "low" | null;
  readonly needsHumanReview: boolean;
  readonly confirmsExistingCustomer: boolean;
  readonly productCategoryMentioned: "weight_loss_medication" | "other_business_line" | "none";
}

/**
 * Second, independent layer on top of the system prompt's grounding
 * paragraph (see systemPrompt) — a self-reported enum can be wrong the same
 * way any model output can be wrong, so this scans the actual drafted text
 * for phrasing associated with the real hallucination this is guarding
 * against ("digital health platforms, patient engagement tools, and
 * practice management services"), independent of what Claude declared in
 * productCategoryMentioned. Deliberately phrase-based rather than
 * single-word ("platform", "software") to stay narrow enough not to
 * misfire on a legitimate reply, which never has reason to use this
 * vocabulary in the first place — every real reply here is either asking
 * for a name/email or describing the one real product.
 */
const OFF_SCOPE_REPLY_PATTERNS: readonly RegExp[] = [
  /\bplatforms?\b/i,
  /\bpatient engagement\b/i,
  /\bpractice management\b/i,
  /\bsaas\b/i,
  /\bsoftware\b/i,
  /\bportal\b/i,
  /\b(ehr|emr)\b/i,
  /\bconsulting\b/i,
  /\bstaffing\b/i,
  /\bit services\b/i,
  /\bmarketing services\b/i,
  /\bscheduling (software|tool|system)\b/i,
  /\bfor (providers|clinics|offices|practices|hospitals)\b/i,
  /\bb2b\b/i,
  /\benterprise\b/i,
];

function suggestedReplyMentionsOffScopeService(reply: string): boolean {
  return OFF_SCOPE_REPLY_PATTERNS.some((pattern) => pattern.test(reply));
}

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "classify_unmatched_sms",
  description: "Classify an inbound text thread from an unrecognized phone number and draft a safe, generic reply — auto-sent unless it needs a human to look at it first.",
  input_schema: {
    type: "object",
    properties: {
      intent: { type: "string", enum: ["new_lead_interest", "existing_customer_support", "spam_or_irrelevant", "other"] },
      summary: { type: "string", description: "One sentence: what does this person want?" },
      suggestedReply: {
        type: ["string", "null"],
        description:
          "A short, safe, generic reply — no clinical claims, no pricing figures, no promises. If senderName is null, this MUST ask for their name — do not answer any product/pricing question yet, even if they asked one. If senderName is known but senderEmail is null, this MUST ask for their email instead, framed as needing to start an account for them before going over product or pricing details (e.g. 'Before I go over pricing or product details, let me get an account started for you — what's your email?') — never ask for both name and email in the same message, and still don't answer the product/pricing question yet. Null only for spam_or_irrelevant.",
      },
      senderName: {
        type: ["string", "null"],
        description: "The sender's full name, if known — only if they actually stated or signed it somewhere in the thread. Null if genuinely unknown. Once known (passed in below), keep returning the same value.",
      },
      senderEmail: {
        type: ["string", "null"],
        description: "The sender's email address, only if they actually stated it somewhere in the thread. Null if genuinely unknown. Once known (passed in below), keep returning the same value.",
      },
      matchCandidateIndex: {
        type: ["integer", "null"],
        description: "0-based index into the provided candidate list if this sender is plausibly one of those existing customers, else null. Never guess beyond the given list.",
      },
      matchConfidence: { type: ["string", "null"], enum: ["high", "medium", "low", null] },
      needsHumanReview: {
        type: "boolean",
        description:
          "True when you genuinely can't confidently draft a safe reply yourself — real confusion about what they want, or anything needing individualized medical/clinical judgment (e.g. 'is this safe for my condition') — false for the ordinary cases you're equipped to handle (asking for a name or email, a plain informational question you can answer within the rules above). When true, suggestedReply is still your best-effort draft, but it's held for a person to review instead of sent automatically.",
      },
      confirmsExistingCustomer: {
        type: "boolean",
        description:
          "Only meaningful when told below that a prior message already asked this sender to confirm they're an existing customer under a different name. True only if their latest reply clearly confirms that (e.g. 'yes', 'that's me', gives the other name). False otherwise — including whenever that situation hasn't come up, an unclear reply, or a clear denial.",
      },
      productCategoryMentioned: {
        type: "string",
        enum: ["weight_loss_medication", "other_business_line", "none"],
        description:
          "Does suggestedReply describe, imply, or reference what Ark Health offers, does, or sells? 'weight_loss_medication' if it references the one real product (prescription semaglutide/tirzepatide via intake questionnaire). 'other_business_line' if it references or implies ANY other service, product category, or business line — software, platforms, patient engagement, practice management, consulting, staffing, or anything else — set this even if you're not fully sure it's inaccurate, since Ark doesn't offer anything beyond the medication program. 'none' if the reply doesn't describe what Ark offers at all (e.g. just asking for a name or email). Answer honestly — this is checked independently of the reply text itself.",
      },
    },
    required: [
      "intent",
      "summary",
      "suggestedReply",
      "senderName",
      "senderEmail",
      "matchCandidateIndex",
      "matchConfidence",
      "needsHumanReview",
      "confirmsExistingCustomer",
      "productCategoryMentioned",
    ],
  },
};

function buildTranscript(messages: readonly UnmatchedSmsMessage[]): string {
  const capped = messages.slice(-MAX_TRANSCRIPT_MESSAGES);
  const lines = capped.map((m) => `${m.direction === "inbound" ? "Sender" : "Ark Health"}: ${m.body}`);
  let text = lines.join("\n");
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = "...\n" + text.slice(-(MAX_TRANSCRIPT_CHARS - 4));
  }
  return text;
}

function systemPrompt(candidates: readonly MatchCandidate[], knownName: string | null, knownEmail: string | null, pendingConfirmation: boolean): string {
  const candidateList = candidates.length
    ? candidates.map((c, i) => `${i}: ${c.firstName} ${c.lastName} (${c.email})`).join("\n")
    : "(no plausible candidates found)";

  const pendingConfirmationNote = pendingConfirmation
    ? `\nIMPORTANT: on a prior turn, we already asked this sender to confirm whether they go by a different name, because the email they gave matches an existing account under a different name. Read their latest reply in the thread below: if it clearly confirms that's them (e.g. "yes", "that's me", they give the other name), set confirmsExistingCustomer to true and draft a brief reply acknowledging you've found their account — do not restate or guess the name on file. If the reply is unclear or denies it, set confirmsExistingCustomer to false and continue normally (treat them as a new contact, asking for whatever's still needed).\n`
    : "";

  return `You triage inbound SMS at Ark Health, a healthcare company, for a phone number that doesn't match any customer record in the CRM. You're seeing the full text thread so far with this sender, not just one message.

Ark Health's actual product is prescription weight-loss medication —
semaglutide and tirzepatide — prescribed after a short online intake
questionnaire is reviewed by a licensed provider. That's the ONLY thing to
describe when asked what Ark Health offers, does, or sells. A real
customer was once told Ark offers "digital health platforms, patient
engagement tools, and practice management services" — none of which are
real; you invented that because nothing told you what the business
actually does. Never invent services, product categories, or business
lines beyond the one above. If asked about something outside this (e.g.
peptides, other medications, anything you're not sure Ark offers), don't
confirm or deny it either way — stay non-committal and keep moving the
conversation forward through the normal flow (name/email/handoff) instead
of answering with a guess. Set productCategoryMentioned honestly on every
turn, even when you're confident suggestedReply is fine — it's checked
independently of the reply text itself.
${pendingConfirmationNote}

Classify the message and draft a reply. Unless you set needsHumanReview:true, this reply is sent automatically — no one reviews it first. Take that seriously: stay inside the rules below, and set needsHumanReview:true the moment you're genuinely unsure rather than guessing.

We currently know the sender's name as: ${knownName ?? "unknown"}.
We currently know the sender's email as: ${knownEmail ?? "unknown"}.
${
  knownName && knownEmail
    ? `\nWe already have both their name and email, and the thread shows genuine interest in our products (not spam, not someone claiming to already be a customer) — that's a hot lead. Classify intent as new_lead_interest for THIS turn, even if the specific message you're looking at is just a short acknowledgment ("thanks", "ok", "cool") with no new content of its own. Judge intent from what this person is here for overall, not from the newest message in isolation — that doesn't change just because their latest reply happens to be brief. This matters more than it looks: once we have both name and email, new_lead_interest is what hands them off into a real, live sales conversation instead of leaving them stuck talking to you indefinitely, getting a generic "we'll get back to you" instead of actually being helped. Only classify something other than new_lead_interest here if they say something that genuinely changes the picture (e.g. they're actually an existing customer with a support issue, or they say they're no longer interested).\n`
    : ""
}
Rules for the suggested reply:
- Never state or imply a price, discount, or specific dollar figure.
- Never give clinical/medical advice, dosing information, or comment on a specific medication.
- Never promise a timeline, outcome, or that a specific person will follow up — including vague versions of this ("we'll get back to you soon", "someone will be in touch"). We aren't actually queuing a human follow-up here; if you're not asking for something (name/email) or answering a plain question, that's usually a sign intent should be new_lead_interest instead (see above), not a sign-off.
- Keep it to 1-2 short sentences, texting style (contractions, no formal tone).
- If we don't know their name yet, the reply MUST ask for it (e.g. "Hey! Could you share your name so I know who I'm chatting with?") — this takes priority over anything else, including a product/pricing question they may have already asked.
- If we know their name but not their email, the reply MUST ask for their email instead, framed as getting an account started before going over product or pricing details (e.g. "Thanks ${knownName}! Before I go over pricing or product details, let me get an account started for you — what's your email?") — never ask for both name and email in the same message, and still don't answer their product/pricing question yet even though you now know their name.
- If they push back on giving their email — asking why you need it (e.g. "why do you need my email"), or saying they'd rather wait/hold off — do NOT just ask for it again with different wording. Re-asking the same question three times in a row reads as nagging, not helpful, even when each version is phrased differently. On the FIRST pushback, switch to a different, low-friction question instead of repeating yourself: ask what state they're in, framed around checking what promotions/pricing are available there (e.g. "No worries! What state are you in? I can look into what promotions are available for you there."). Check the thread above first — if you already asked this state question, don't ask it again; instead circle back to email, framed around what's actually in it for them (e.g. "Just need your email too so I can actually get you those numbers — what's your email?"). Still asking for the email eventually, just not on every single turn in a row.
- Do not include a greeting/sign-off beyond what reads naturally in a text.
- If the message is spam, a phishing attempt, an automated notification, or otherwise not a real inquiry, set intent to spam_or_irrelevant and suggestedReply to null.

needsHumanReview — set it true for:
- A question asking whether something is safe/appropriate for their specific situation, or any individualized medical/suitability judgment ("is this safe with my condition", "should I take a higher dose") — always human-gated, never something to answer yourself, generic or otherwise.
- Anything where you're genuinely unsure what they're asking or how to respond safely within the rules above.
Leave it false for the ordinary cases: asking for a name or email, a plain informational question you can answer within the rules, or straightforward small talk.

For senderName and senderEmail: if we already know them, just return those same values. Otherwise extract only what the sender actually states themselves somewhere in the thread — never guess.

Possible existing customers this sender might be (matched by name appearing in their messages) — only pick one if you're confident, based on real evidence, never based on the topic alone. Note: even a confident match here always gets held for human review before anything is linked or sent — never treat a match as license to skip that.
${candidateList}`;
}

async function classifyAndDraft(
  fromPhone: string,
  fromName: string | null,
  collectedEmail: string | null,
  messages: readonly UnmatchedSmsMessage[],
  candidates: readonly MatchCandidate[],
  pendingConfirmation: boolean,
): Promise<Classification> {
  const client = getClient();
  const transcript = buildTranscript(messages);

  const createPromise = client.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: systemPrompt(candidates, fromName, collectedEmail, pendingConfirmation),
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "classify_unmatched_sms" },
    messages: [{ role: "user", content: `From: ${fromPhone}\n\nThread so far:\n${transcript}` }],
  });

  const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), CALL_TIMEOUT_MS));
  const response = await Promise.race([createPromise, timeoutPromise]);

  const toolBlock = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "classify_unmatched_sms");
  if (!toolBlock) {
    throw new Error("Claude did not return a classify_unmatched_sms tool call.");
  }
  return toolBlock.input as Classification;
}

async function getOrCreateThread(fromPhone: string): Promise<UnmatchedSmsThread> {
  const [existing] = await db.select().from(unmatchedSmsThreadsTable).where(eq(unmatchedSmsThreadsTable.fromPhone, fromPhone));
  if (existing) return existing;

  const [created] = await db
    .insert(unmatchedSmsThreadsTable)
    .values({ fromPhone })
    .onConflictDoNothing({ target: unmatchedSmsThreadsTable.fromPhone })
    .returning();
  if (created) return created;

  const [row] = await db.select().from(unmatchedSmsThreadsTable).where(eq(unmatchedSmsThreadsTable.fromPhone, fromPhone));
  return row;
}

/** First token as firstName, remainder (if any) as lastName — customers.lastName is NOT NULL, so a single-word name gets an empty-string lastName rather than failing. */
function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  return { firstName: parts[0] ?? fullName, lastName: parts.slice(1).join(" ") };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The only place this pipeline creates data unattended: a brand-new
 * customer row, never a link to an existing one (that stays human-gated via
 * suggestedMatchCustomerId, same as the email version). Only fires once we
 * have a real name AND a real-looking email, this thread isn't a plausible
 * match to an existing customer, and Claude hasn't flagged this specific
 * turn as spam or as someone claiming to already be a customer.
 *
 * Deliberately does NOT require classification.intent === "new_lead_interest"
 * — a real production case showed why: once name and email are both on
 * file, a customer's later replies are often short acknowledgments ("thanks",
 * "ok") or bare answers to whatever was just asked, which Claude classifies
 * per-turn from that one message alone and can reasonably read as "other"
 * rather than re-asserting "new_lead_interest" every time. Gating lead
 * creation on that one exact label firing again silently stranded a real
 * lead in this queue indefinitely (no lead created, no handoff to Alexis,
 * just an endless string of Claude's own generic replies) until a staff
 * member noticed and stepped in manually. Once we have a real name and
 * email and nothing below rules it out, that's enough evidence on its own —
 * spam senders don't hand over a working name and email and keep replying.
 */
async function maybeCreateLead(
  thread: UnmatchedSmsThread,
  classification: Classification,
  matchedExisting: boolean,
): Promise<{ customerId: string; justCreated: boolean } | null> {
  if (thread.linkedCustomerId) return { customerId: thread.linkedCustomerId, justCreated: false };
  if (matchedExisting) return null;
  if (classification.intent === "spam_or_irrelevant" || classification.intent === "existing_customer_support") return null;

  const name = thread.fromName ?? classification.senderName;
  const email = thread.collectedEmail ?? classification.senderEmail;
  if (!name || !email || !EMAIL_RE.test(email)) return null;

  const { firstName, lastName } = splitName(name);
  const [created] = await db
    .insert(customersTable)
    .values({
      firstName,
      lastName,
      email,
      phone: thread.fromPhone,
      leadReceivedDate: new Date().toISOString().slice(0, 10),
      leadType: "SMS Inquiry",
    })
    .returning({ id: customersTable.id });

  logger.info({ threadId: thread.id, customerId: created.id }, "created a new lead from an unmatched inbound SMS");
  return { customerId: created.id, justCreated: true };
}

/**
 * Auto-connects to an existing customer with NO human review — the one
 * exception to "any match stays human-gated" above. Two ways in:
 *   1. The texted name AND the collected email both point at the exact same
 *      existing customer — neither signal alone (a name match could be a
 *      common-name coincidence; an email match alone doesn't confirm this
 *      is really the same person texting) is enough, but both agreeing is
 *      unambiguous enough that a rubber-stamp step is friction, not safety.
 *   2. The email matches but the name doesn't (or isn't known), and the
 *      sender has since explicitly confirmed in the conversation that it's
 *      them under a different name (see the pendingConfirmation flow in
 *      recordAndClassifyUnmatchedSms and systemPrompt) — a person, not a
 *      string match, vouched for the identity, which is exactly what the
 *      "held for a person to double check" case above is protecting
 *      against, just answered by the sender themselves instead of staff.
 *
 * Updates the customer's phone to this number so every message after this
 * one routes through the normal known-customer path (findCustomerIdByPhone
 * in iblusend-webhook.service.ts) instead of re-running this unmatched-
 * sender flow every time — otherwise "rolls into the conversation" would
 * only be true for this one message, not an ongoing state.
 */
async function findAutoConnectCustomerId(
  nameMatch: MatchCandidate | undefined,
  emailMatch: MatchCandidate | undefined,
  emailMatchConfirmed: boolean,
  phone: string,
): Promise<string | null> {
  const matchedId = nameMatch && emailMatch && nameMatch.id === emailMatch.id ? nameMatch.id : emailMatch && emailMatchConfirmed ? emailMatch.id : null;
  if (!matchedId) return null;
  await db.update(customersTable).set({ phone }).where(eq(customersTable.id, matchedId));
  return matchedId;
}

/**
 * Everything said in this thread before the hand-off, minus the final
 * message — that one gets re-added by processInboundMessage/
 * processInboundSupportMessage themselves as the actual inbound turn, so
 * including it here would double it up.
 *
 * Without this, the guardrailed pipeline a lead or auto-connect gets handed
 * to starts a brand-new conversation with NOTHING in it but that one final
 * message — no name, no "why do you need my email", no context for what
 * they're even asking about. A trigger message that only made sense as an
 * answer to a question this pipeline never saw (e.g. a bare email address
 * on its own) can leave Claude with nothing coherent to react to, which is
 * exactly the kind of input that trips the guardrail loop into silence —
 * confirmed against a real conversation where this happened.
 */
async function seedPriorHistory(append: (direction: "inbound" | "outbound", body: string) => Promise<unknown>, priorMessages: readonly UnmatchedSmsMessage[]): Promise<void> {
  for (const m of priorMessages.slice(0, -1)) {
    await append(m.direction, m.body);
  }
}

/**
 * Same support-vs-lead routing as dispatchInboundMessage in
 * iblusend-webhook.service.ts — duplicated rather than imported since that
 * one isn't exported and this is a small, self-contained check.
 */
async function dispatchToExistingCustomer(customerId: string, body: string, priorMessages: readonly UnmatchedSmsMessage[]): Promise<void> {
  const [supportConversation] = await db.select({ id: supportConversationsTable.id }).from(supportConversationsTable).where(eq(supportConversationsTable.personId, customerId));
  if (supportConversation) {
    await seedPriorHistory((direction, msgBody) => appendSupportMessage(supportConversation.id, direction, msgBody), priorMessages);
    await processInboundSupportMessage(customerId, body);
    return;
  }
  const conversation = await getOrCreateConversation(customerId, "meta_form");
  await seedPriorHistory((direction, msgBody) => appendMessage(conversation.id, direction, msgBody), priorMessages);
  await processInboundMessage(customerId, body, "meta_form");
}

export async function listUnmatchedSmsMessages(threadId: string): Promise<UnmatchedSmsMessage[]> {
  return db.select().from(unmatchedSmsMessagesTable).where(eq(unmatchedSmsMessagesTable.threadId, threadId)).orderBy(unmatchedSmsMessagesTable.createdAt);
}

const ACK_VARIANTS = [
  "Hey! Thanks for reaching out to Ark Health — could you share your name so I know who I'm chatting with? Our team will follow up shortly.",
  "Hi there, thanks for texting Ark Health! What's your name so I know who I'm talking to? We'll follow up with you shortly.",
] as const;

/**
 * Sent instead of Claude's drafted reply the first time an email this
 * sender gives turns out to match an existing customer under a different
 * name — fixed and deterministic rather than Claude-drafted because this
 * exact turn is the one where the match is discovered, before Claude ever
 * had a chance to be told about it (see the pendingConfirmation flow one
 * turn later). Deliberately doesn't name the account on file — asking
 * generically avoids handing account details to whoever is actually
 * texting, in case it isn't really that person.
 */
const EMAIL_MATCH_CONFIRM_VARIANTS = [
  "Thanks! Quick check on my end — that email's already on file with us under a different name. Do you go by another name too, or should I double check the email?",
  "Got it! One thing — we've got that email on file under a different name already. Is that you going by another name, or want to double check the email you gave me?",
] as const;

function pickVariant(variants: readonly string[]): string {
  return variants[Math.floor(Math.random() * variants.length)];
}

async function sendSmsAndLog(threadId: string, fromPhone: string, body: string): Promise<boolean> {
  let providerMessageId: string | null = null;
  try {
    const result = await getSmsProvider().sendMessage(fromPhone, body);
    providerMessageId = result.providerMessageId;
  } catch (err) {
    logger.warn({ threadId, reason: err instanceof Error ? err.message : String(err) }, "unmatched-sms send failed");
    return false;
  }
  await db.insert(unmatchedSmsMessagesTable).values({ threadId, direction: "outbound", body, providerMessageId });
  return true;
}

/**
 * The fixed, content-free acknowledgment asking for a name — the one thing
 * this pipeline sends before Claude has even seen the thread, since it's
 * always the right first move regardless of what the message turns out to
 * say. Only ever fires on a thread's first message. Every message after
 * that goes through classifyAndDraft's own reply instead (auto-sent unless
 * flagged needsHumanReview — see recordAndClassifyUnmatchedSms).
 */
async function sendAutoAcknowledgment(threadId: string, fromPhone: string): Promise<void> {
  await sendSmsAndLog(threadId, fromPhone, pickVariant(ACK_VARIANTS));
}

/**
 * Records the inbound text (joining the sender's existing thread if one
 * exists) and attaches a best-effort classification/draft, re-run against
 * the FULL thread history each time — a Claude failure (timeout,
 * misconfigured key, malformed output) still leaves the message recorded
 * with nothing AI-generated attached, rather than losing it, and the
 * thread stays needs_review since there's no AI judgment to lean on. A new
 * inbound message on a thread previously replied-to or dismissed
 * resurfaces it by resetting status back to needs_review, unless this new
 * message itself gets auto-replied to.
 */
export async function recordAndClassifyUnmatchedSms(fromPhone: string, body: string): Promise<UnmatchedSmsThread> {
  const normalizedPhone = normalizePhone(fromPhone);
  const thread = await getOrCreateThread(normalizedPhone);

  const priorMessages = await listUnmatchedSmsMessages(thread.id);
  const isFirstMessage = priorMessages.length === 0;

  await db.insert(unmatchedSmsMessagesTable).values({ threadId: thread.id, direction: "inbound", body });

  const messages = await listUnmatchedSmsMessages(thread.id);
  const transcriptText = messages.map((m) => m.body).join(" ");

  const candidates = await findMatchCandidates(thread.fromName, transcriptText).catch((err) => {
    logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "unmatched-sms candidate lookup failed");
    return [];
  });

  // Pre-classification check: does the email we already collected on a
  // PRIOR turn match an existing customer whose name doesn't (yet) agree?
  // If so, we already sent the fixed confirmation question below on that
  // earlier turn, so this turn's classification needs to know it's likely
  // reading the sender's answer to it (see pendingConfirmationNote in
  // systemPrompt). Only looks at thread.collectedEmail — a brand-new email
  // given THIS turn can't have been asked about yet, so that case is
  // handled separately below, after classification runs.
  const preEmailLookup = thread.collectedEmail
    ? await findExistingCustomerByEmail(thread.collectedEmail).catch((err) => {
        logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "unmatched-sms pending-confirmation email lookup failed");
        return { candidate: undefined, ambiguous: false };
      })
    : { candidate: undefined, ambiguous: false };
  const preEmailMatch = preEmailLookup.candidate;
  const pendingConfirmation = Boolean(preEmailMatch) && !thread.linkedCustomerId && !candidates.some((c) => c.id === preEmailMatch!.id);

  let classification: Classification | null = null;
  try {
    classification = await classifyAndDraft(normalizedPhone, thread.fromName, thread.collectedEmail, messages, candidates, pendingConfirmation);
  } catch (err) {
    logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "unmatched-sms classification failed");
  }

  const nameMatch =
    classification?.matchCandidateIndex !== null && classification?.matchCandidateIndex !== undefined ? candidates[classification.matchCandidateIndex] : undefined;

  // Deterministic exact-email check, independent of Claude's own judgment —
  // see findExistingCustomerByEmail's docstring for why this can't just be
  // folded into the pre-classification candidate search. Takes priority
  // over a name-based match when both somehow point at different people.
  const knownEmailThisTurn = thread.collectedEmail ?? classification?.senderEmail ?? null;
  const emailLookup = knownEmailThisTurn
    ? await findExistingCustomerByEmail(knownEmailThisTurn).catch((err) => {
        logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "unmatched-sms email match lookup failed");
        return { candidate: undefined, ambiguous: false };
      })
    : { candidate: undefined, ambiguous: false };
  const emailMatch = emailLookup.candidate;
  const matchCandidate = emailMatch ?? nameMatch;

  // Force human review for cases where auto-replying risks being actively
  // wrong, not just "Claude wasn't sure": a plausible match to an existing
  // customer (never auto-linked — see maybeCreateLead), an email that
  // matches more than one customer record (findExistingCustomerByEmail's
  // ambiguous case — real data, but we can't safely say which person it
  // is), or someone claiming to already be a customer all need a person to
  // confirm identity before anything goes out, regardless of Claude's own
  // confidence. Does not apply when the match resolves on its own — either
  // signal agrees (see findAutoConnectCustomerId) or the sender is about to
  // be asked to confirm it themselves (see isFirstEncounterWithEmailMatch
  // below) — an ambiguous email match never qualifies for either, since
  // neither path can say who, specifically, was confirmed.
  // Two independent checks on top of Claude's own needsHumanReview flag,
  // neither trusting the other: did it self-report describing a business
  // line beyond the real product, and separately, does the actual drafted
  // text match known off-scope phrasing regardless of what it self-reported
  // (see suggestedReplyMentionsOffScopeService's docstring). Either one
  // alone is enough to hold this for a person.
  const offScopeReply = Boolean(
    classification?.productCategoryMentioned === "other_business_line" ||
      (classification?.suggestedReply && suggestedReplyMentionsOffScopeService(classification.suggestedReply)),
  );
  if (offScopeReply) {
    logger.warn(
      { threadId: thread.id, selfReported: classification?.productCategoryMentioned === "other_business_line" },
      "unmatched-SMS reply flagged as describing an out-of-scope business line, holding for review",
    );
  }

  const needsHumanReview = Boolean(
    classification?.needsHumanReview || matchCandidate || emailLookup.ambiguous || classification?.intent === "existing_customer_support" || offScopeReply,
  );

  // A message Claude flags for an unrelated reason (needsHumanReview true)
  // still goes to a person even when the email/name confirmation itself
  // checks out — "the sender confirmed who they are" doesn't override "this
  // reply also needs a person to look at it" for some other, separate
  // reason.
  const autoConnectCustomerId = thread.linkedCustomerId
    ? null
    : await findAutoConnectCustomerId(nameMatch, emailMatch, Boolean(classification?.confirmsExistingCustomer) && !classification?.needsHumanReview, normalizedPhone);

  const leadResult = classification && !autoConnectCustomerId ? await maybeCreateLead(thread, classification, Boolean(matchCandidate) || emailLookup.ambiguous) : null;

  // The email just given THIS turn (not previously on file) turns out to
  // match an existing customer, and the texted name doesn't already agree
  // — rather than immediately parking for a person to double-check (the
  // matchCandidate override above would otherwise do exactly that), ask
  // the sender a generic, account-detail-free confirmation question and
  // let their next reply resolve it via pendingConfirmation above. Only
  // the FIRST time we see this (thread.collectedEmail was empty coming
  // into this turn) — once asked, later turns fall through to the normal
  // needsHumanReview handling if the reply doesn't clearly resolve it.
  const isFirstEncounterWithEmailMatch =
    Boolean(emailMatch) && !autoConnectCustomerId && !thread.linkedCustomerId && !thread.collectedEmail && !(nameMatch && emailMatch && nameMatch.id === emailMatch.id);

  let autoSent = false;
  if (autoConnectCustomerId) {
    // Name and email both matched the same existing customer — no review
    // needed, no new lead to create, just route this message (and every
    // one after it, via the phone-number update in
    // findAutoConnectCustomerId) into their real conversation.
    try {
      await dispatchToExistingCustomer(autoConnectCustomerId, body, messages);
    } catch (err) {
      logger.warn({ threadId: thread.id, reason: err instanceof Error ? err.message : String(err) }, "auto-connect handoff failed");
    }
  } else if (leadResult?.justCreated) {
    // Confident enough to create the lead means confident enough to hand
    // THIS message straight to Alexis's real, guardrailed pipeline — not the
    // generic staff queue. Same trust level Alexis already operates at
    // unattended for every other lead. Treated as a Meta lead-gen contact
    // (state/currentlyTaking/product first, then proactive pricing), not
    // an abandoned-cart lead — this person never started a Bask
    // questionnaire, they're cold inbound outreach, exactly like a Meta lead.
    try {
      const conversation = await getOrCreateConversation(leadResult.customerId, "meta_form");
      await seedPriorHistory((direction, msgBody) => appendMessage(conversation.id, direction, msgBody), messages);
      await processInboundMessage(leadResult.customerId, body, "meta_form");
    } catch (err) {
      logger.warn({ threadId: thread.id, reason: err instanceof Error ? err.message : String(err) }, "handoff to Alexis after lead creation failed");
    }
  } else if (isFirstEncounterWithEmailMatch && classification?.intent !== "spam_or_irrelevant") {
    // Ask instead of park — see isFirstEncounterWithEmailMatch's comment
    // above. Fixed wording, not Claude-drafted: this turn is the one where
    // the match is discovered, before Claude could ever have been told
    // about it to draft an informed question.
    autoSent = await sendSmsAndLog(thread.id, normalizedPhone, pickVariant(EMAIL_MATCH_CONFIRM_VARIANTS));
  } else if (isFirstMessage && classification?.intent !== "spam_or_irrelevant") {
    // One immediate, fixed, content-free acknowledgment per thread — see
    // sendAutoAcknowledgment's docstring. Only on the thread's first-ever
    // message; skipped above when Alexis is about to reply live instead. Also
    // skipped for spam/irrelevant. A failed classification call
    // (classification is null) still gets the ack, same as the email
    // version — no way to know it's spam without Claude.
    await sendAutoAcknowledgment(thread.id, normalizedPhone);
  } else if (classification && classification.intent !== "spam_or_irrelevant" && !needsHumanReview && classification.suggestedReply) {
    // Everything past the first message is auto-sent by default now too —
    // Claude's own drafted reply, sent directly, the same trust level the
    // fixed first-message ack already operates at. The content itself
    // stays bounded by the drafting rules in the system prompt (no prices,
    // no clinical claims, no promises) regardless of who hits send; the
    // needsHumanReview flag above is the actual safety valve, not a
    // missing review step.
    autoSent = await sendSmsAndLog(thread.id, normalizedPhone, classification.suggestedReply);
  }

  const [updated] = await db
    .update(unmatchedSmsThreadsTable)
    .set({
      fromName: thread.fromName ?? classification?.senderName ?? undefined,
      collectedEmail: thread.collectedEmail ?? classification?.senderEmail ?? undefined,
      aiIntent: classification?.intent ?? thread.aiIntent,
      aiSummary: classification?.summary ?? thread.aiSummary,
      suggestedReply: autoConnectCustomerId || leadResult?.justCreated || autoSent ? null : (classification?.suggestedReply ?? thread.suggestedReply),
      // Auto-connect means the match was confirmed, not just suggested —
      // clear the "possible match" fields rather than leaving them set
      // alongside an already-linked thread.
      suggestedMatchCustomerId: autoConnectCustomerId ? null : (matchCandidate?.id ?? thread.suggestedMatchCustomerId),
      // An exact email match is unambiguous — always "high", regardless of
      // (or even absent) Claude's own matchConfidence, which only ever
      // covers the name-based candidate list it was shown.
      suggestedMatchConfidence: autoConnectCustomerId ? null : emailMatch ? "high" : matchCandidate ? (classification?.matchConfidence ?? null) : thread.suggestedMatchConfidence,
      linkedCustomerId: autoConnectCustomerId ?? leadResult?.customerId ?? thread.linkedCustomerId,
      status: autoConnectCustomerId || leadResult?.justCreated || autoSent ? "replied" : "needs_review",
      repliedAt: autoConnectCustomerId || leadResult?.justCreated || autoSent ? new Date() : thread.repliedAt,
    })
    .where(eq(unmatchedSmsThreadsTable.id, thread.id))
    .returning();
  return updated;
}

export interface UnmatchedSmsThreadSummary extends UnmatchedSmsThread {
  readonly lastMessageAt: Date | null;
  readonly lastMessagePreview: string | null;
}

/** Hand-qualified raw query — same reasoning as listUnmatchedEmailThreads: an unqualified "id" in a correlated subquery with no outer JOIN can silently resolve to the wrong table's id. */
export async function listUnmatchedSmsThreads(): Promise<UnmatchedSmsThreadSummary[]> {
  const { rows } = await db.execute<{
    id: string;
    fromPhone: string;
    fromName: string | null;
    collectedEmail: string | null;
    aiIntent: UnmatchedSmsThread["aiIntent"];
    aiSummary: string | null;
    suggestedMatchCustomerId: string | null;
    suggestedMatchConfidence: UnmatchedSmsThread["suggestedMatchConfidence"];
    suggestedReply: string | null;
    linkedCustomerId: string | null;
    status: UnmatchedSmsThread["status"];
    repliedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    lastMessageAt: Date | null;
    lastMessagePreview: string | null;
  }>(sql`
    select
      t.id, t.from_phone as "fromPhone", t.from_name as "fromName", t.collected_email as "collectedEmail",
      t.ai_intent as "aiIntent", t.ai_summary as "aiSummary",
      t.suggested_match_customer_id as "suggestedMatchCustomerId", t.suggested_match_confidence as "suggestedMatchConfidence",
      t.suggested_reply as "suggestedReply", t.linked_customer_id as "linkedCustomerId", t.status, t.replied_at as "repliedAt",
      t.created_at as "createdAt", t.updated_at as "updatedAt",
      (select max(m.created_at) from unmatched_sms_messages m where m.thread_id = t.id) as "lastMessageAt",
      (select m.body from unmatched_sms_messages m where m.thread_id = t.id order by m.created_at desc limit 1) as "lastMessagePreview"
    from unmatched_sms_threads t
    order by (select max(m.created_at) from unmatched_sms_messages m where m.thread_id = t.id) desc nulls last
  `);
  return rows;
}

export async function getUnmatchedSmsThread(id: string): Promise<UnmatchedSmsThread | undefined> {
  const [row] = await db.select().from(unmatchedSmsThreadsTable).where(eq(unmatchedSmsThreadsTable.id, id));
  return row;
}

export async function getUnmatchedSmsThreadDetail(id: string): Promise<{ thread: UnmatchedSmsThread; messages: UnmatchedSmsMessage[] } | undefined> {
  const thread = await getUnmatchedSmsThread(id);
  if (!thread) return undefined;
  const messages = await listUnmatchedSmsMessages(id);
  return { thread, messages };
}

export async function dismissUnmatchedSmsThread(id: string): Promise<boolean> {
  const [row] = await db.update(unmatchedSmsThreadsTable).set({ status: "dismissed" }).where(eq(unmatchedSmsThreadsTable.id, id)).returning({ id: unmatchedSmsThreadsTable.id });
  return Boolean(row);
}

export type UnmatchedSmsReplyResult = { readonly sent: true } | { readonly sent: false; readonly reason: "not_found" | "send_failed" };

/** A staff-approved reply to an unmatched sender — the only other path (besides the auto-ack) by which this pipeline ever sends anything. */
export async function sendUnmatchedInboundSmsReply(id: string, body: string): Promise<UnmatchedSmsReplyResult> {
  const thread = await getUnmatchedSmsThread(id);
  if (!thread) return { sent: false, reason: "not_found" };

  let providerMessageId: string | null = null;
  try {
    const result = await getSmsProvider().sendMessage(thread.fromPhone, body);
    providerMessageId = result.providerMessageId;
  } catch (err) {
    logger.warn({ id, reason: err instanceof Error ? err.message : String(err) }, "unmatched-sms staff reply send failed");
    return { sent: false, reason: "send_failed" };
  }

  await db.insert(unmatchedSmsMessagesTable).values({ threadId: thread.id, direction: "outbound", body, providerMessageId });
  await db.update(unmatchedSmsThreadsTable).set({ status: "replied", repliedAt: new Date() }).where(eq(unmatchedSmsThreadsTable.id, id));
  return { sent: true };
}
