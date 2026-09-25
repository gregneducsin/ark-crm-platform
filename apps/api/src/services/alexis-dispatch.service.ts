import { recordSmsInbound, getSmsReplyWork, finishSmsReplyWork, holdSmsReplyForStaff, hasPendingSmsDelivery, sendTrackedSms, type SmsInboundMetadata } from "./sms-delivery.service.js";
import { selectRepeatQuestionAnswer } from "../lib/messaging/repeat-question-answer.js";
import { interactivePreCheck } from "../lib/messaging/safety.js";
import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";
import { runAlexisTurn, type AlexisTurnResult } from "./alexis-conversation.service.js";
import {
  getOrCreateConversation,
  listMessages,
  setMessageSentiment,
  updateConversationState,
  toBotPreviewBody,
  countRecentOutboundMessages,
  type ConversationStatePatch,
} from "./conversations.service.js";
import { logger } from "../lib/logger.js";
import { withPersonLock } from "../lib/db-lock.js";
import { isCustomerSmsDnd, setCustomerSmsDnd } from "./dnd.service.js";
import { isSalesSmsPaused } from "../lib/sales-sms.js";
import { scheduleObjectionReengagement } from "./objection-reengagement.service.js";
import { describeNeedsAttentionReason } from "../lib/messaging/needs-attention-reason.js";
import { countRepeatQuestionsInHistory } from "../lib/messaging/repeat-question.js";




/**
 * Hard ceiling on how many texts Alexis can send one person in a row, no
 * matter how many turns are driving it — a real incident on Luma (same
 * architecture, ported here) showed 15+ real sends to one customer in ~25
 * minutes, each one individually legitimate. This isn't a guardrail or a
 * content check; it doesn't matter why the sends keep coming, only that
 * they stop past this point. 10 in 20 minutes is well under 15 while still
 * leaving room for a genuinely fast real back-and-forth.
 */
const SEND_BURST_LIMIT = 10;
const SEND_BURST_WINDOW_MS = 20 * 60 * 1000;

/**
 * After this many consecutive turns asking essentially the same unresolved
 * question (see repeat-question.ts), stop auto-sending and flag the
 * conversation for a person instead of asking a reworded version again.
 * Ported from Luma, where this was the actual targeted fix for the real
 * incident above — the send-burst cap is a blunt backstop, this is the
 * "we are going in circles" check.
 */
const REPEAT_QUESTION_THRESHOLD = 3;

async function getCustomerContact(personId: string): Promise<{ firstName: string; phone: string | null } | undefined> {
  const [row] = await db.select({ firstName: customersTable.firstName, phone: customersTable.phone }).from(customersTable).where(eq(customersTable.id, personId));
  return row;
}

/**
 * Sends a text through the SMS provider and logs it in the conversation
 * regardless of whether the send succeeds — a send failure (most likely: no
 * provider configured yet) doesn't erase the fact that this is what Alexis's
 * guardrail-approved reply actually was. Failures are logged, not thrown;
 * this function never blocks the caller on a transport problem.
 *
 * Opt-out is applied on receipt; only its deterministic confirmation may bypass DND.
 *
 * When the send-burst cap blocks a reply, flag the unanswered customer
 * message for staff instead of leaving the conversation silently stalled.
 */
async function sendAndLog(personId: string, conversationId: string, phone: string | null, text: string, isCurrent: () => Promise<boolean>, isOptOut = false, generation: string, holdForStaff = false): Promise<void> {
  if (isSalesSmsPaused()) return;
  if (!isOptOut && await isCustomerSmsDnd(personId)) {
    logger.warn({ personId, conversationId }, "outbound Alexis message not sent: customer is do-not-disturb");
    return;
  }

  const recentSends = await countRecentOutboundMessages(conversationId, SEND_BURST_WINDOW_MS);
  if (recentSends >= SEND_BURST_LIMIT) {
    logger.warn({ personId, conversationId, recentSends }, "outbound Alexis message not sent: send-burst limit reached");
    await updateConversationState(conversationId, {
      needsAttention: true,
      needsAttentionReason: "SMS reply withheld because the conversation reached the message limit. Review the latest unanswered customer message and reply manually.",
    });
    return;
  }

  // Recheck after the DND and rate-limit queries, immediately before transport.
  if (!await isCurrent()) return;

  await sendTrackedSms(personId, "sales", conversationId, phone, text, generation, holdForStaff);
}

/**
 * Full inbound-turn pipeline: persist the inbound message, run it through
 * the guardrail loop, tag its sentiment, send (and log) whatever Alexis's
 * validated reply is, and persist the updated conversation state. This is
 * the real dispatch path — it calls the SMS provider for real, same as the
 * follow-up pipeline, and fails the same way (cleanly, loudly, not silently)
 * until a provider is actually configured.
 *
 * Inbound receipt happens before the lock; queued turns coalesce to the latest
 * inbound and discard drafts superseded while the model was running.
 */
export async function processInboundMessage(
  personId: string,
  inboundBody: string,
  initialLeadSource?: "abandoned_cart" | "meta_form",
  mediaUrls?: string[],
  metadata?: SmsInboundMetadata,
): Promise<AlexisTurnResult> {
  // Persist before waiting for the turn lock: an in-flight draft must see new arrivals.
  const conversation = initialLeadSource ? await getOrCreateConversation(personId, initialLeadSource) : await getOrCreateConversation(personId);
  await recordSmsInbound(personId, "sales", conversation.id, inboundBody, mediaUrls, metadata);
  const pre = interactivePreCheck(inboundBody, conversation.lastQuestion);
  // Safety signals must survive coalescing, including a STOP followed by another text.
  if (pre.blocked && pre.code === "OPT_OUT") await setCustomerSmsDnd(personId, true);
  else if (pre.blocked) {
    await updateConversationState(conversation.id, {
      needsAttention: true,
      needsAttentionReason: describeNeedsAttentionReason({ kind: "staff_flagged", preCheckCode: pre.code }),
    });
  }
  return resumeAlexisSms(personId);
}

export async function resumeAlexisSms(personId: string): Promise<AlexisTurnResult> {
  return withPersonLock(personId, async () => {
    if (isSalesSmsPaused()) return { ok: false, code: "SALES_PAUSED" };
    const work = await getSmsReplyWork(personId, "sales");
    if (!work) return { ok: false, code: "SUPERSEDED" };
    if (work.heldForStaff || await hasPendingSmsDelivery(personId)) return { ok: false, code: "DELIVERY_PENDING" };
    const result = await processInboundMessageLocked(personId, work.generation);
    if (result.ok || result.code !== "SUPERSEDED") await finishSmsReplyWork(personId, "sales", work.generation);
    return result;
  });
}

async function processInboundMessageLocked(personId: string, generation: string): Promise<AlexisTurnResult> {
  const conversation = await getOrCreateConversation(personId);
  const messages = await listMessages(conversation.id);
  const inboundMessage = [...messages].reverse().find((message) => message.direction === "inbound");
  if (!inboundMessage) return { ok: false, code: "SUPERSEDED" };
  const inboundMessageId = inboundMessage.id;
  const priorMessages = messages.filter((message) => message.id !== inboundMessageId);
  const knownInboundIds = new Set(messages.filter((message) => message.direction === "inbound").map((message) => message.id));
  const isCurrent = async () => !(await listMessages(conversation.id)).some(
    (message) => message.direction === "inbound" && !knownInboundIds.has(message.id),
  );

  const customer = await getCustomerContact(personId);
  // "Unknown" is the placeholder a webhook-created customer row gets when no
  // name was ever provided (see findOrCreateCustomerByExternalIdentity) — not
  // a real name, so it resolves to null the same as no firstName at all.
  const customerFirstName = customer && customer.firstName && customer.firstName !== "Unknown" ? customer.firstName : null;

  const body = toBotPreviewBody(conversation, messages, customerFirstName);
  let result: AlexisTurnResult;
  try {
    result = await runAlexisTurn(personId, body);
  } catch (err) {
    // Anything that escapes runAlexisTurn itself (e.g. a DB failure minting the
    // intake link on send_form) isn't a guardrail rejection — runAlexisTurn
    // only turns ProviderError into a result, everything else propagates.
    // The customer still got silence, though, so this needs the same "a
    // human should see that" treatment as the !result.ok branch below, not
    // a log line nobody's watching.
    logger.error({ personId, conversationId: conversation.id, reason: err instanceof Error ? err.message : String(err) }, "Alexis turn threw unexpectedly — no outbound message sent");
    await updateConversationState(conversation.id, { needsAttention: true, needsAttentionReason: describeNeedsAttentionReason({ kind: "exception" }) });
    return { ok: false, code: "UNEXPECTED_ERROR" };
  }

  if (!await isCurrent()) return { ok: false, code: "SUPERSEDED" };

  if (!result.ok) {
    logger.warn({ personId, conversationId: conversation.id, code: result.code }, "Alexis turn rejected — no outbound message sent");
    // The customer got silence, not just a routed reply — that's exactly the
    // kind of thing a human should see, not just a log line.
    await updateConversationState(conversation.id, { needsAttention: true, needsAttentionReason: describeNeedsAttentionReason({ kind: "rejected", code: result.code }) });
    return result;
  }

  await setMessageSentiment(inboundMessage.id, result.inboundSentiment);

  // Guarded against overwriting a real name even though the prompt already
  // instructs Claude never to report learnedFirstName once customerFirstName
  // is non-null — trust but verify, same posture as every other AI-extracted
  // field in this codebase (e.g. the unmatched-email sender-name matching).
  if (result.learnedFirstName && customerFirstName === null) {
    await db.update(customersTable).set({ firstName: result.learnedFirstName }).where(eq(customersTable.id, personId));
  }

  // Stuck-repeating check: is this turn's nextQuestion essentially the same
  // one Alexis has already asked (reworded) several times in a row without the
  // conversation moving forward? Real incident: a customer kept answering a
  // "which plan length" question in different words, none of which Alexis
  // recognized as resolving it, so she just re-asked a reworded version
  // turn after turn — eventually ~20 real texts to one customer. Every
  // individual turn was a legitimate, guardrail-approved reply to a real
  // inbound message, so no single-turn or volume-based check could catch
  // this — only recognizing the repetition itself can.
  const repeatStreak = countRepeatQuestionsInHistory(priorMessages, result.nextQuestion);
  const isStuckRepeating = repeatStreak >= REPEAT_QUESTION_THRESHOLD - 1;

  if (isStuckRepeating) {
    const answer = selectRepeatQuestionAnswer(result, conversation.lastDraft);
    logger.warn({ personId, conversationId: conversation.id, repeatStreak, answerEligible: answer !== null }, "Alexis suppressed a repeated question and routed the conversation to staff");
    // Flag before transport, so a delivery failure or a newer safety signal
    // can replace this reason rather than being overwritten by it afterward.
    await updateConversationState(conversation.id, { needsAttention: true, needsAttentionReason: describeNeedsAttentionReason(result.requiresStaff ? { kind: "staff_flagged", preCheckCode: result.preCheckCode } : { kind: "stuck_repeating" }) });
    try {
      if (answer) await sendAndLog(personId, conversation.id, customer?.phone ?? null, answer, isCurrent, false, generation, true);
    } finally {
      await holdSmsReplyForStaff(personId, "sales");
    }
    result = { ...result, reply: answer, nextQuestion: null, requiresStaff: true };
  } else {
    const text = [result.reply, result.nextQuestion].filter((t): t is string => Boolean(t?.trim())).join("\n\n");
    if (text) await sendAndLog(personId, conversation.id, customer?.phone ?? null, text, isCurrent, result.preCheckCode === "OPT_OUT", generation);
  }

  if (!await isCurrent()) return { ok: false, code: "SUPERSEDED" };

  // Retain the deterministic turn result as a second opt-out safeguard.
  if (result.preCheckCode === "OPT_OUT") {
    await setCustomerSmsDnd(personId, true);
  }

  const slotPatch: ConversationStatePatch = {};
  for (const [key, value] of Object.entries(result.validatedSlotUpdates)) {
    (slotPatch as Record<string, unknown>)[key] = value;
  }

  await updateConversationState(conversation.id, {
    ...slotPatch,
    lastQuestion: result.nextQuestion,
    lastDraft: isStuckRepeating ? (result.reply ?? conversation.lastDraft) : result.reply,
    objectionStage: result.objectionStage,
    objectionKey: result.objectionKey,
    linkProvided: result.linkProvided,
    promoOffered: result.promoOffered,
    ...(!isStuckRepeating && result.requiresStaff
        ? { needsAttention: true, needsAttentionReason: describeNeedsAttentionReason({ kind: "staff_flagged", preCheckCode: result.preCheckCode }) }
        : {}),
  });

  // A stand-down ("I'll leave it here for whenever you're ready" / "we're
  // here whenever the timing's better") is terminal for THIS conversation,
  // not the end of outreach — see objection-reengagement.service.ts.
  if ((result.objectionKey === "think_about_it" || result.objectionKey === "price") && result.objectionStage === 2) {
    await scheduleObjectionReengagement(personId, conversation.leadSource);
  }

  return result;
}
