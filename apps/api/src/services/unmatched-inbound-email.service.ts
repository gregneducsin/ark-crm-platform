import Anthropic from "@anthropic-ai/sdk";
import { eq, sql } from "drizzle-orm";
import {
  db,
  customersTable,
  unmatchedEmailThreadsTable,
  unmatchedEmailMessagesTable,
  type UnmatchedEmailThread,
  type UnmatchedEmailMessage,
} from "@luma/db";
import { getEmailProvider } from "../lib/email-provider.js";
import { processInboundEmail } from "./alexis-email-dispatch.service.js";
import { getOrCreateEmailConversation, appendEmailMessage } from "./email-conversations.service.js";
import { normalizePhone } from "../lib/phone.js";
import { logger } from "../lib/logger.js";
import { notifySlack } from "../lib/slack.js";

/**
 * What used to happen to an inbound email from an address matching no
 * customer record: logged and silently dropped, invisible to staff. This
 * records it instead, grouped into one thread per sender (a second email
 * from the same address joins the existing thread, not a disconnected
 * duplicate), with a Claude-drafted classification and reply attached.
 *
 * Auto-sent by default: the fixed first-message ack, and every
 * classification-drafted reply after it, go out immediately with no human
 * in the loop — the safety rail is Claude's own needsHumanReview flag (set
 * when it's genuinely unsure, or for an individualized medical/suitability
 * question) plus two hard overrides this file applies regardless of what
 * Claude reports: a plausible match to an existing customer, or a sender
 * claiming to already have an account. suggestedMatchCustomerId (a guess
 * that this sender might be a DIFFERENT, already-existing customer) is
 * never applied automatically either way: matching health-context
 * correspondence to the wrong customer by an unverified fuzzy match is
 * exactly the kind of mistake this system should never make unattended, so
 * a human confirms it explicitly before anything acts on it.
 *
 * The one thing this pipeline does automatically that creates data — a new
 * lead — is a deliberately different risk category: it only ever adds a
 * new, clearly-sourced customer row (never touches or links to an existing
 * person's record), and only once we actually know the sender's name AND a
 * phone number, and Claude is confident this is a genuine prospective
 * customer. The phone requirement mirrors the SMS pipeline's requirement
 * for a name AND an email before it creates anything: an email inquiry
 * always comes with a working email address (that's how the sender is
 * reaching us), but never a phone, so collectedPhone on the thread plays
 * the same role collectedEmail plays for unmatched SMS senders — gathered
 * mid-conversation, not guessed. That's the same trust level every other
 * unattended lead-capture path in this app already operates at (the
 * GHL/Meta webhooks create customers with no human review either) — it's
 * the "guess which existing person this is" action that stays human-gated,
 * not "add a new row for someone new."
 *
 * The moment a lead is created, the triggering message itself is handed
 * off to Alexis's real, guardrailed pipeline (alexis-email-dispatch.service.ts's
 * processInboundEmail) as a Meta-lead-style conversation, instead of
 * sitting in this queue with a generic draft — being confident enough to
 * create the lead means being confident enough to let the same pipeline
 * every other lead gets handle it live. Every message from that sender
 * after this one skips this file entirely, since findCustomerIdByEmail now
 * matches them on the normal inbound-email path (email-inbound.service.ts).
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
 * Conservative substring match, not a fuzzy/similarity search: a candidate
 * only qualifies if BOTH their first and last name literally appear in the
 * sender's display name or the thread's message text. This is deliberately
 * narrow — the cost of a false positive here (suggesting the wrong person
 * as a match on a health-context thread) is much higher than the cost of
 * missing a real match that staff could instead find by searching manually.
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

interface Classification {
  readonly intent: "new_lead_interest" | "existing_customer_support" | "spam_or_irrelevant" | "other";
  readonly summary: string;
  readonly suggestedReply: string | null;
  readonly senderName: string | null;
  readonly senderPhone: string | null;
  readonly matchCandidateIndex: number | null;
  readonly matchConfidence: "high" | "medium" | "low" | null;
  readonly needsHumanReview: boolean;
}

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "classify_unmatched_email",
  description: "Classify an inbound email thread from an unrecognized sender and draft a safe, generic reply — auto-sent unless it needs a human to look at it first.",
  input_schema: {
    type: "object",
    properties: {
      intent: { type: "string", enum: ["new_lead_interest", "existing_customer_support", "spam_or_irrelevant", "other"] },
      summary: { type: "string", description: "One sentence: what does this person want?" },
      suggestedReply: {
        type: ["string", "null"],
        description:
          "A short, safe, generic reply body — no greeting/sign-off (added separately), no clinical claims, no pricing figures, no promises. If senderName is null, this MUST include asking for their name so we can help them properly. If senderName is known but senderPhone is null, this MUST ask for their phone number instead, framed as needing it to start an account/look into things for them before going over product or pricing details — never ask for both name and phone in the same message, and don't answer their product/pricing question yet even though you know their name. Null only for spam_or_irrelevant.",
      },
      senderName: {
        type: ["string", "null"],
        description: "The sender's full name, if known — from the From header display name (given separately) or signed/stated anywhere in the thread. Null if genuinely unknown.",
      },
      senderPhone: {
        type: ["string", "null"],
        description: "The sender's phone number, only if they actually stated it somewhere in the thread. Null if genuinely unknown. Once known (passed in below), keep returning the same value.",
      },
      matchCandidateIndex: {
        type: ["integer", "null"],
        description: "0-based index into the provided candidate list if this sender is plausibly one of those existing customers, else null. Never guess beyond the given list.",
      },
      matchConfidence: { type: ["string", "null"], enum: ["high", "medium", "low", null] },
      needsHumanReview: {
        type: "boolean",
        description:
          "True when you genuinely can't confidently draft a safe reply yourself — real confusion about what they want, or anything needing individualized medical/clinical judgment (e.g. 'is this safe for my condition') — false for the ordinary cases you're equipped to handle (asking for a name, a plain informational question you can answer within the rules above). When true, suggestedReply is still your best-effort draft, but it's held for a person to review instead of sent automatically.",
      },
    },
    required: ["intent", "summary", "suggestedReply", "senderName", "senderPhone", "matchCandidateIndex", "matchConfidence", "needsHumanReview"],
  },
};

function buildTranscript(messages: readonly UnmatchedEmailMessage[]): string {
  const capped = messages.slice(-MAX_TRANSCRIPT_MESSAGES);
  const lines = capped.map((m) => `${m.direction === "inbound" ? "Sender" : "Ark Health"} (Subject: ${m.subject}): ${m.body}`);
  let text = lines.join("\n\n");
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = "...\n" + text.slice(-(MAX_TRANSCRIPT_CHARS - 4));
  }
  return text;
}

function systemPrompt(candidates: readonly MatchCandidate[], knownName: string | null, knownPhone: string | null): string {
  const candidateList = candidates.length
    ? candidates.map((c, i) => `${i}: ${c.firstName} ${c.lastName} (${c.email})`).join("\n")
    : "(no plausible candidates found)";

  return `You triage inbound email at Ark Health, a healthcare company, for a sender whose email address doesn't match any customer record in the CRM. You're seeing the full thread so far with this sender, not just one message.

Classify the message and draft a reply. Unless you set needsHumanReview:true, this reply is sent automatically — no one reviews it first. Take that seriously: stay inside the rules below, and set needsHumanReview:true the moment you're genuinely unsure rather than guessing.

We currently know the sender's name as: ${knownName ?? "unknown"}.
We currently know the sender's phone number as: ${knownPhone ?? "unknown"}.

Rules for the suggested reply:
- Never state or imply a price, discount, or specific dollar figure.
- Never give clinical/medical advice, dosing information, or comment on a specific medication.
- Never promise a timeline, outcome, or that a specific person will follow up.
- Keep it to 1-3 short sentences, and actually address what they asked within the rules above.
- If we don't know their name yet, the reply MUST ask for it naturally (e.g. "Could you share your name so we can look into this for you?") — asking for their name takes priority over any other clarifying question, including a product/pricing question they may have already asked.
- If we know their name but not their phone number, the reply MUST ask for their phone number instead, framed as needing it to get an account started or to look into things for them (e.g. "Thanks ${knownName}! Before I go over pricing or product details, let me get an account started for you — what's a good phone number for you?") — never ask for both name and phone in the same message, and still don't answer their product/pricing question yet even though you now know their name.
- If they push back asking why you need their phone number, don't repeat the "starting an account" framing again — answer with what's in it for them (e.g. "Just need it so I can look into the promotions/pricing for you — what's your number?"), still asking for it.
- Do not include a greeting ("Hi ...") or sign-off — those are added separately.
- If the message is spam, a phishing attempt, an automated notification, or otherwise not a real inquiry, set intent to spam_or_irrelevant and suggestedReply to null.

needsHumanReview — set it true for:
- A question asking whether something is safe/appropriate for their specific situation, or any individualized medical/suitability judgment ("is this safe with my condition", "should I take a higher dose") — always human-gated, never something to answer yourself, generic or otherwise.
- Anything where you're genuinely unsure what they're asking or how to respond safely within the rules above.
Leave it false for the ordinary cases: asking for a name or phone number, or a plain informational question you can answer within the rules.

For senderName: if we already know it (${knownName ?? "unknown"}), just return that. Otherwise extract it only if the sender actually states or signs their name somewhere in the thread — never guess from an email address or writing style.
For senderPhone: if we already know it, just return that same value. Otherwise extract it only if the sender actually states it themselves somewhere in the thread — never guess.

Possible existing customers this sender might be (matched by name appearing in their messages) — only pick one if you're confident, based on real evidence (e.g. they sign with a matching name), never based on the topic alone. Note: even a confident match here always gets held for human review before anything is linked or sent — never treat a match as license to skip that.
${candidateList}`;
}

async function classifyAndDraft(
  fromAddress: string,
  fromName: string | null,
  knownPhone: string | null,
  messages: readonly UnmatchedEmailMessage[],
  candidates: readonly MatchCandidate[],
): Promise<Classification> {
  const client = getClient();
  const transcript = buildTranscript(messages);
  const knownName = fromName;

  const createPromise = client.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: systemPrompt(candidates, knownName, knownPhone),
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "classify_unmatched_email" },
    messages: [{ role: "user", content: `From: ${fromName ? `${fromName} <${fromAddress}>` : fromAddress}\n\nThread so far:\n${transcript}` }],
  });

  const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), CALL_TIMEOUT_MS));
  const response = await Promise.race([createPromise, timeoutPromise]);

  const toolBlock = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "classify_unmatched_email");
  if (!toolBlock) {
    throw new Error("Claude did not return a classify_unmatched_email tool call.");
  }
  return toolBlock.input as Classification;
}

async function getOrCreateThread(fromAddress: string, fromName: string | null, receivingAddress?: string): Promise<UnmatchedEmailThread> {
  const [existing] = await db.select().from(unmatchedEmailThreadsTable).where(eq(unmatchedEmailThreadsTable.fromAddress, fromAddress));
  if (existing) {
    // See email-conversations.service.ts's getOrCreateEmailConversation for
    // why this stays in sync on every inbound message, not just at creation.
    if (receivingAddress && existing.receivingAddress !== receivingAddress) {
      const [updated] = await db
        .update(unmatchedEmailThreadsTable)
        .set({ receivingAddress })
        .where(eq(unmatchedEmailThreadsTable.id, existing.id))
        .returning();
      return updated;
    }
    return existing;
  }

  const [created] = await db
    .insert(unmatchedEmailThreadsTable)
    .values({ fromAddress, fromName, receivingAddress: receivingAddress ?? null })
    .onConflictDoNothing({ target: unmatchedEmailThreadsTable.fromAddress })
    .returning();
  if (created) return created;

  const [row] = await db.select().from(unmatchedEmailThreadsTable).where(eq(unmatchedEmailThreadsTable.fromAddress, fromAddress));
  return row;
}

/** first token as firstName, remainder (if any) as lastName — customers.lastName is NOT NULL, so a single-word name gets an empty-string lastName rather than failing. */
function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  return { firstName: parts[0] ?? fullName, lastName: parts.slice(1).join(" ") };
}

/** A real-looking phone number: at least 10 digits once punctuation/spacing is stripped — same bar normalizePhone itself resolves cleanly, not a stricter format check. */
function looksLikePhone(value: string): boolean {
  return value.replace(/\D/g, "").length >= 10;
}

/**
 * The only place this pipeline creates data unattended: a brand-new
 * customer row, never a link to an existing one. Only fires once we have a
 * real name AND a real-looking phone number, Claude is confident this is a
 * genuine prospective customer (not spam/irrelevant, not someone claiming
 * to already be a customer — that case goes to matchCandidateIndex instead,
 * human-gated), and this thread hasn't already been linked to a customer.
 */
async function maybeCreateLead(
  thread: UnmatchedEmailThread,
  classification: Classification,
  matchedExisting: boolean,
): Promise<{ customerId: string; justCreated: boolean } | null> {
  if (thread.linkedCustomerId) return { customerId: thread.linkedCustomerId, justCreated: false };
  if (matchedExisting) return null;
  if (classification.intent !== "new_lead_interest") return null;

  const name = thread.fromName ?? classification.senderName;
  const phone = thread.collectedPhone ?? classification.senderPhone;
  if (!name || !phone || !looksLikePhone(phone)) return null;

  const { firstName, lastName } = splitName(name);
  const [created] = await db
    .insert(customersTable)
    .values({
      firstName,
      lastName,
      email: thread.fromAddress,
      phone: normalizePhone(phone),
      leadReceivedDate: new Date().toISOString().slice(0, 10),
      leadType: "Email Inquiry",
    })
    .returning({ id: customersTable.id });

  logger.info({ threadId: thread.id, customerId: created.id }, "created a new lead from an unmatched inbound email");
  return { customerId: created.id, justCreated: true };
}

export async function listUnmatchedEmailMessages(threadId: string): Promise<UnmatchedEmailMessage[]> {
  return db.select().from(unmatchedEmailMessagesTable).where(eq(unmatchedEmailMessagesTable.threadId, threadId)).orderBy(unmatchedEmailMessagesTable.createdAt);
}

const ACK_ASKING_NAME_VARIANTS = [
  "Thanks for reaching out to Ark Health — could you share your name so we can help you further? A member of our team will follow up shortly.",
  "Thanks for getting in touch with Ark Health — could you let us know your name so we can help you out? Our team will follow up shortly.",
] as const;

/** Actually greets the sender by name — a flat "our team will follow up" with no personalization reads as a form-letter brush-off even when we already know exactly who's writing in. */
function ackKnownNameVariants(firstName: string): readonly string[] {
  return [
    `Hey ${firstName}, we received your email and we'll reach out here shortly.`,
    `Hi ${firstName} — got your message, and someone from our team will follow up with you shortly.`,
  ];
}

function pickVariant(variants: readonly string[]): string {
  return variants[Math.floor(Math.random() * variants.length)];
}

async function sendEmailAndLog(
  threadId: string,
  fromAddress: string,
  subject: string,
  body: string,
  inReplyTo: string | null,
  fromEmailOverride: string | null,
): Promise<boolean> {
  const replySubject = /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;

  let messageId: string | null = null;
  try {
    const { provider } = getEmailProvider("alexis");
    const html = wrapReplyHtml(body);
    const result = await provider.sendEmail(fromAddress, replySubject, html, {
      fromName: "Ark Health Team",
      inReplyTo: inReplyTo ?? undefined,
      references: inReplyTo ?? undefined,
      fromEmailOverride: fromEmailOverride ?? undefined,
    });
    messageId = result.messageId;
  } catch (err) {
    logger.warn({ threadId, reason: err instanceof Error ? err.message : String(err) }, "unmatched-email send failed");
    return false;
  }

  await db.insert(unmatchedEmailMessagesTable).values({ threadId, direction: "outbound", subject: replySubject, body, messageId });
  return true;
}

/**
 * The fixed, content-free acknowledgment asking for a name — the one thing
 * this pipeline sends before Claude has even seen the thread, since it's
 * always the right first move regardless of what the message turns out to
 * say. Deliberately a hardcoded template, picked at random from a small set
 * of equivalent variants (see pickVariant) so every unmatched sender across
 * the whole inbox doesn't get the exact same byte-for-byte sentence. Only
 * ever fires on a thread's first message. Every message after that goes
 * through classifyAndDraft's own reply instead (auto-sent unless flagged
 * needsHumanReview — see recordAndClassifyUnmatchedEmail).
 */
async function sendAutoAcknowledgment(
  threadId: string,
  fromAddress: string,
  subject: string,
  knownName: string | null,
  inReplyTo: string | null,
  fromEmailOverride: string | null,
): Promise<void> {
  const body = knownName ? pickVariant(ackKnownNameVariants(splitName(knownName).firstName)) : pickVariant(ACK_ASKING_NAME_VARIANTS);
  await sendEmailAndLog(threadId, fromAddress, subject, body, inReplyTo, fromEmailOverride);
}

/**
 * Records the inbound message (joining the sender's existing thread if one
 * exists) and attaches a best-effort classification/draft, re-run against
 * the FULL thread history each time — a Claude failure (timeout,
 * misconfigured key, malformed output) still leaves the message recorded
 * with nothing AI-generated attached, rather than losing it. A new inbound
 * message on a thread previously replied-to or dismissed resurfaces it by
 * resetting status back to needs_review.
 */
export async function recordAndClassifyUnmatchedEmail(input: {
  fromAddress: string;
  fromName: string | null;
  subject: string;
  body: string;
  messageId: string | null;
  receivingAddress?: string;
}): Promise<UnmatchedEmailThread> {
  const thread = await getOrCreateThread(input.fromAddress, input.fromName, input.receivingAddress);
  if (input.fromName && !thread.fromName) {
    await db.update(unmatchedEmailThreadsTable).set({ fromName: input.fromName }).where(eq(unmatchedEmailThreadsTable.id, thread.id));
  }

  const priorMessages = await listUnmatchedEmailMessages(thread.id);
  const isFirstMessage = priorMessages.length === 0;
  if (isFirstMessage) {
    void notifySlack(`New unmatched email — ${input.fromAddress}`);
  }

  await db.insert(unmatchedEmailMessagesTable).values({
    threadId: thread.id,
    direction: "inbound",
    subject: input.subject,
    body: input.body,
    messageId: input.messageId,
  });

  const messages = await listUnmatchedEmailMessages(thread.id);
  const knownName = input.fromName ?? thread.fromName;
  const transcriptText = messages.map((m) => m.body).join(" ");

  const candidates = await findMatchCandidates(knownName, transcriptText).catch((err) => {
    logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "unmatched-email candidate lookup failed");
    return [];
  });

  let classification: Classification | null = null;
  try {
    classification = await classifyAndDraft(input.fromAddress, knownName, thread.collectedPhone, messages, candidates);
  } catch (err) {
    logger.warn({ reason: err instanceof Error ? err.message : String(err) }, "unmatched-email classification failed");
  }

  const matchCandidate =
    classification?.matchCandidateIndex !== null && classification?.matchCandidateIndex !== undefined ? candidates[classification.matchCandidateIndex] : undefined;

  // Force human review for cases where auto-replying risks being actively
  // wrong, not just "Claude wasn't sure": a plausible match to an existing
  // customer (never auto-linked — see maybeCreateLead) or someone claiming
  // to already be a customer both need a person to confirm identity before
  // anything goes out, regardless of Claude's own confidence.
  const needsHumanReview = Boolean(classification?.needsHumanReview || matchCandidate || classification?.intent === "existing_customer_support");

  const leadResult = classification ? await maybeCreateLead(thread, classification, Boolean(matchCandidate)) : null;

  let autoSent = false;
  if (leadResult?.justCreated) {
    // Confident enough to create the lead means confident enough to hand
    // THIS message straight to Alexis's real, guardrailed pipeline — not the
    // generic staff queue. Same trust level Alexis already operates at
    // unattended for every other lead; sending the generic acknowledgment
    // on top would just be a redundant second email. Treated as a Meta
    // lead-gen contact (state/currentlyTaking/product first, then
    // proactive pricing), not an abandoned-cart lead — this person never
    // started a Bask questionnaire, they're cold inbound outreach, exactly
    // like a Meta lead.
    try {
      // Seed the new Alexis conversation with everything said in this thread
      // before this final triggering message — without it, Alexis starts
      // from nothing but a bare final message with no context for what
      // this person already asked about or said, which can leave her with
      // nothing coherent to react to (confirmed against a real case of
      // this producing total silence on the equivalent SMS path).
      const emailConversation = await getOrCreateEmailConversation(leadResult.customerId, "meta_form", thread.receivingAddress ?? undefined);
      for (const m of messages.slice(0, -1)) {
        await appendEmailMessage(emailConversation.id, m.direction, m.subject, m.body);
      }
      await processInboundEmail(leadResult.customerId, input.subject, input.body, input.messageId, "meta_form", thread.receivingAddress ?? undefined);
    } catch (err) {
      logger.warn({ threadId: thread.id, reason: err instanceof Error ? err.message : String(err) }, "handoff to Alexis after lead creation failed");
    }
  } else if (isFirstMessage && classification?.intent !== "spam_or_irrelevant") {
    // One immediate, fixed, content-free acknowledgment per thread — see
    // sendAutoAcknowledgment's docstring. Only on the thread's first-ever
    // message, so a repeat sender doesn't get re-acknowledged on every
    // email; skipped above when Alexis is about to send the real thing
    // instead. Also skipped for spam/irrelevant — replying to an automated
    // bounce notice or a spam sender wastes a send at best, and at worst
    // signals to a real spammer that this address is live and reads its
    // mail. A failed classification call (classification is null) still
    // gets the ack, same as before — no way to know it's spam without
    // Claude, so default to acknowledging.
    await sendAutoAcknowledgment(thread.id, input.fromAddress, input.subject, knownName, input.messageId, thread.receivingAddress);
  } else if (classification && classification.intent !== "spam_or_irrelevant" && !needsHumanReview && classification.suggestedReply) {
    // Everything past the first message is auto-sent by default now too —
    // Claude's own drafted reply, sent directly, the same trust level the
    // fixed first-message ack already operates at. The content itself
    // stays bounded by the drafting rules in the system prompt (no prices,
    // no clinical claims, no promises) regardless of who hits send; the
    // needsHumanReview flag above is the actual safety valve, not a
    // missing review step.
    autoSent = await sendEmailAndLog(thread.id, input.fromAddress, input.subject, classification.suggestedReply, input.messageId, thread.receivingAddress);
  }

  const [updated] = await db
    .update(unmatchedEmailThreadsTable)
    .set({
      fromName: knownName ?? classification?.senderName ?? undefined,
      collectedPhone: thread.collectedPhone ?? classification?.senderPhone ?? undefined,
      aiIntent: classification?.intent ?? thread.aiIntent,
      aiSummary: classification?.summary ?? thread.aiSummary,
      suggestedReply: leadResult?.justCreated || autoSent ? null : (classification?.suggestedReply ?? thread.suggestedReply),
      suggestedMatchCustomerId: matchCandidate?.id ?? thread.suggestedMatchCustomerId,
      suggestedMatchConfidence: matchCandidate ? (classification?.matchConfidence ?? null) : thread.suggestedMatchConfidence,
      linkedCustomerId: leadResult?.customerId ?? thread.linkedCustomerId,
      status: leadResult?.justCreated || autoSent ? "replied" : "needs_review",
      repliedAt: leadResult?.justCreated || autoSent ? new Date() : thread.repliedAt,
    })
    .where(eq(unmatchedEmailThreadsTable.id, thread.id))
    .returning();
  return updated;
}

export interface UnmatchedEmailThreadSummary extends UnmatchedEmailThread {
  readonly lastMessageAt: Date | null;
  readonly lastMessagePreview: string | null;
}

/**
 * Hand-qualified raw query, not the `.select({...})` builder: drizzle only
 * table-qualifies column references in a correlated subquery when the outer
 * query also has a JOIN — without one, an unqualified "id" inside the
 * subquery resolves to unmatched_email_messages.id (it has its own id PK
 * too) instead of the intended unmatched_email_threads.id, silently
 * returning null for every row. There's no natural join target here, so
 * this is qualified explicitly instead of relying on that quirk.
 */
export async function listUnmatchedEmailThreads(): Promise<UnmatchedEmailThreadSummary[]> {
  const { rows } = await db.execute<{
    id: string;
    fromAddress: string;
    fromName: string | null;
    collectedPhone: string | null;
    aiIntent: UnmatchedEmailThread["aiIntent"];
    aiSummary: string | null;
    suggestedMatchCustomerId: string | null;
    suggestedMatchConfidence: UnmatchedEmailThread["suggestedMatchConfidence"];
    suggestedReply: string | null;
    linkedCustomerId: string | null;
    receivingAddress: string | null;
    status: UnmatchedEmailThread["status"];
    repliedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    lastMessageAt: Date | null;
    lastMessagePreview: string | null;
  }>(sql`
    select
      t.id, t.from_address as "fromAddress", t.from_name as "fromName", t.collected_phone as "collectedPhone",
      t.ai_intent as "aiIntent", t.ai_summary as "aiSummary",
      t.suggested_match_customer_id as "suggestedMatchCustomerId", t.suggested_match_confidence as "suggestedMatchConfidence",
      t.suggested_reply as "suggestedReply", t.linked_customer_id as "linkedCustomerId", t.receiving_address as "receivingAddress",
      t.status, t.replied_at as "repliedAt",
      t.created_at as "createdAt", t.updated_at as "updatedAt",
      (select max(m.created_at) from unmatched_email_messages m where m.thread_id = t.id) as "lastMessageAt",
      (select m.body from unmatched_email_messages m where m.thread_id = t.id order by m.created_at desc limit 1) as "lastMessagePreview"
    from unmatched_email_threads t
    order by (select max(m.created_at) from unmatched_email_messages m where m.thread_id = t.id) desc nulls last
  `);
  return rows;
}

export async function getUnmatchedEmailThread(id: string): Promise<UnmatchedEmailThread | undefined> {
  const [row] = await db.select().from(unmatchedEmailThreadsTable).where(eq(unmatchedEmailThreadsTable.id, id));
  return row;
}

export async function getUnmatchedEmailThreadDetail(id: string): Promise<{ thread: UnmatchedEmailThread; messages: UnmatchedEmailMessage[] } | undefined> {
  const thread = await getUnmatchedEmailThread(id);
  if (!thread) return undefined;
  const messages = await listUnmatchedEmailMessages(id);
  return { thread, messages };
}

export async function dismissUnmatchedEmailThread(id: string): Promise<boolean> {
  const [row] = await db.update(unmatchedEmailThreadsTable).set({ status: "dismissed" }).where(eq(unmatchedEmailThreadsTable.id, id)).returning({ id: unmatchedEmailThreadsTable.id });
  return Boolean(row);
}

export type UnmatchedEmailReplyResult = { readonly sent: true } | { readonly sent: false; readonly reason: "not_found" | "send_failed" };

/**
 * Deliberately not wrapEmailHtml/renderConversationReplyEmail — those bake
 * in an unsubscribe footer keyed to a known customer's personId, which
 * doesn't exist here. This is a direct, on-demand reply to a stranger's own
 * inquiry (not an automated/bulk send this pipeline initiated), so it
 * doesn't carry the same CAN-SPAM unsubscribe-link obligation those do.
 */
function wrapReplyHtml(bodyText: string): string {
  const paragraphs = bodyText
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("");
  return `<div style="font-family: -apple-system, sans-serif; font-size: 15px; line-height: 1.5; color: #1a1a1a; max-width: 600px;">${paragraphs}</div>`;
}

/** A staff-approved reply to an unmatched sender — the only path by which this pipeline ever actually sends anything. Threads off the most recent message in the thread (inbound or outbound, whichever is last). */
export async function sendUnmatchedInboundEmailReply(id: string, body: string): Promise<UnmatchedEmailReplyResult> {
  const detail = await getUnmatchedEmailThreadDetail(id);
  if (!detail) return { sent: false, reason: "not_found" };
  const { thread, messages } = detail;

  const lastMessage = messages.at(-1);
  const lastSubject = lastMessage?.subject ?? "Your message to Ark Health";
  const subject = /^re:/i.test(lastSubject.trim()) ? lastSubject : `Re: ${lastSubject}`;

  let messageId: string | null = null;
  try {
    const { provider } = getEmailProvider("alexis");
    const html = wrapReplyHtml(body);
    const result = await provider.sendEmail(thread.fromAddress, subject, html, {
      fromName: "Ark Health Team",
      inReplyTo: lastMessage?.messageId ?? undefined,
      references: lastMessage?.messageId ?? undefined,
      fromEmailOverride: thread.receivingAddress ?? undefined,
    });
    messageId = result.messageId;
  } catch (err) {
    logger.warn({ id, reason: err instanceof Error ? err.message : String(err) }, "unmatched-email staff reply send failed");
    return { sent: false, reason: "send_failed" };
  }

  await db.insert(unmatchedEmailMessagesTable).values({ threadId: thread.id, direction: "outbound", subject, body, messageId });
  await db.update(unmatchedEmailThreadsTable).set({ status: "replied", repliedAt: new Date() }).where(eq(unmatchedEmailThreadsTable.id, id));
  return { sent: true };
}
