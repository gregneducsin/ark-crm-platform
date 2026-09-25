import { recordSmsInbound, getSmsReplyWork, finishSmsReplyWork, holdSmsReplyForStaff, hasPendingSmsDelivery, sendTrackedSms, type SmsInboundMetadata } from "./sms-delivery.service.js";
import { selectRepeatQuestionAnswer } from "../lib/messaging/repeat-question-answer.js";
import { interactivePreCheck } from "../lib/messaging/safety.js";
import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";
import { runSophieTurn, type SophieTurnResult } from "./sophie-conversation.service.js";
import {
  getOrCreateSupportConversation,
  listSupportMessages,
  setSupportMessageSentiment,
  updateSupportConversationState,
  toSophiePreviewBody,
  countRecentOutboundSupportMessages,
  type SupportConversationStatePatch,
} from "./support-conversations.service.js";
import { logger } from "../lib/logger.js";
import { withPersonLock } from "../lib/db-lock.js";
import { isCustomerSmsDnd, setCustomerSmsDnd } from "./dnd.service.js";
import { describeNeedsAttentionReason } from "../lib/messaging/needs-attention-reason.js";
import { countRepeatQuestionsInHistory } from "../lib/messaging/repeat-question.js";

/** Same reasoning and numbers as alexis-dispatch.service.ts's SEND_BURST_LIMIT/WINDOW — see that file's comment. */
const SEND_BURST_LIMIT = 10;
const SEND_BURST_WINDOW_MS = 20 * 60 * 1000;

/** Same reasoning as alexis-dispatch.service.ts's REPEAT_QUESTION_THRESHOLD — see that file's comment. */
const REPEAT_QUESTION_THRESHOLD = 3;

async function getCustomerContact(personId: string): Promise<{ firstName: string; phone: string | null } | undefined> {
  const [row] = await db.select({ firstName: customersTable.firstName, phone: customersTable.phone }).from(customersTable).where(eq(customersTable.id, personId));
  return row;
}

/**
 * Same fail-soft send+log pattern as Alexis's dispatch (alexis-dispatch.service.ts's
 * sendAndLog), including the same DND-checked-here-not-earlier reasoning and
 * the same send-burst cap — see that function's docstring.
 */
async function sendAndLog(personId: string, conversationId: string, phone: string | null, text: string, isCurrent: () => Promise<boolean>, isOptOut = false, generation: string, holdForStaff = false): Promise<void> {
  if (!isOptOut && await isCustomerSmsDnd(personId)) {
    logger.warn({ personId, conversationId }, "outbound Sophie message not sent: customer is do-not-disturb");
    return;
  }

  const recentSends = await countRecentOutboundSupportMessages(conversationId, SEND_BURST_WINDOW_MS);
  if (recentSends >= SEND_BURST_LIMIT) {
    logger.warn({ personId, conversationId, recentSends }, "outbound Sophie message not sent: send-burst limit reached");
    await updateSupportConversationState(conversationId, {
      needsAttention: true,
      needsAttentionReason: "SMS reply withheld because the conversation reached the message limit. Review the latest unanswered customer message and reply manually.",
    });
    return;
  }

  // Recheck after the DND and rate-limit queries, immediately before transport.
  if (!await isCurrent()) return;

  await sendTrackedSms(personId, "support", conversationId, phone, text, generation, holdForStaff);
}

/**
 * Full inbound-turn pipeline for Sophie, mirroring processInboundMessage in
 * alexis-dispatch.service.ts: persist the inbound message, run the guardrail
 * loop, tag sentiment, send+log the validated reply, persist updated state.
 *
 * Receipt precedes the lock so queued turns can coalesce to the latest inbound.
 */
export async function processInboundSupportMessage(personId: string, inboundBody: string, mediaUrls?: string[], metadata?: SmsInboundMetadata): Promise<SophieTurnResult> {
  // Persist before waiting for the turn lock: an in-flight draft must see new arrivals.
  const conversation = await getOrCreateSupportConversation(personId);
  await recordSmsInbound(personId, "support", conversation.id, inboundBody, mediaUrls, metadata);
  const pre = interactivePreCheck(inboundBody, conversation.lastQuestion);
  // Safety signals must survive coalescing, including a STOP followed by another text.
  if (pre.blocked && pre.code === "OPT_OUT") await setCustomerSmsDnd(personId, true);
  else if (pre.blocked) {
    await updateSupportConversationState(conversation.id, {
      needsAttention: true,
      needsAttentionReason: describeNeedsAttentionReason({ kind: "staff_flagged", preCheckCode: pre.code }),
    });
  }
  return resumeSophieSms(personId);
}

export async function resumeSophieSms(personId: string): Promise<SophieTurnResult> {
  return withPersonLock(personId, async () => {
    const work = await getSmsReplyWork(personId, "support");
    if (!work) return { ok: false, code: "SUPERSEDED" };
    if (work.heldForStaff || await hasPendingSmsDelivery(personId)) return { ok: false, code: "DELIVERY_PENDING" };
    const result = await processInboundSupportMessageLocked(personId, work.generation);
    if (result.ok || result.code !== "SUPERSEDED") await finishSmsReplyWork(personId, "support", work.generation);
    return result;
  });
}

async function processInboundSupportMessageLocked(personId: string, generation: string): Promise<SophieTurnResult> {
  const conversation = await getOrCreateSupportConversation(personId);
  const messages = await listSupportMessages(conversation.id);
  const inboundMessage = [...messages].reverse().find((message) => message.direction === "inbound");
  if (!inboundMessage) return { ok: false, code: "SUPERSEDED" };
  const inboundMessageId = inboundMessage.id;
  const priorMessages = messages.filter((message) => message.id !== inboundMessageId);
  const knownInboundIds = new Set(messages.filter((message) => message.direction === "inbound").map((message) => message.id));
  const isCurrent = async () => !(await listSupportMessages(conversation.id)).some(
    (message) => message.direction === "inbound" && !knownInboundIds.has(message.id),
  );

  const body = toSophiePreviewBody(conversation, messages);
  let result: SophieTurnResult;
  try {
    result = await runSophieTurn(body);
  } catch (err) {
    // Same reasoning as alexis-dispatch.service.ts's equivalent catch: anything
    // that escapes runSophieTurn itself isn't a guardrail rejection, but the
    // patient still got silence, so it needs the same staff-visible flag.
    logger.error({ personId, conversationId: conversation.id, reason: err instanceof Error ? err.message : String(err) }, "Sophie turn threw unexpectedly — no outbound message sent");
    await updateSupportConversationState(conversation.id, { needsAttention: true, needsAttentionReason: describeNeedsAttentionReason({ kind: "exception" }) });
    return { ok: false, code: "UNEXPECTED_ERROR" };
  }

  if (!await isCurrent()) return { ok: false, code: "SUPERSEDED" };

  if (!result.ok) {
    logger.warn({ personId, conversationId: conversation.id, code: result.code }, "Sophie turn rejected — no outbound message sent");
    await updateSupportConversationState(conversation.id, { needsAttention: true, needsAttentionReason: describeNeedsAttentionReason({ kind: "rejected", code: result.code }) });
    return result;
  }

  await setSupportMessageSentiment(inboundMessage.id, result.inboundSentiment);

  const customer = await getCustomerContact(personId);

  // Stuck-repeating check — see the identical comment and reasoning in
  // alexis-dispatch.service.ts's processInboundMessageLocked.
  const repeatStreak = countRepeatQuestionsInHistory(priorMessages, result.nextQuestion);
  const isStuckRepeating = repeatStreak >= REPEAT_QUESTION_THRESHOLD - 1;

  if (isStuckRepeating) {
    const answer = selectRepeatQuestionAnswer(result, conversation.lastDraft);
    logger.warn({ personId, conversationId: conversation.id, repeatStreak, answerEligible: answer !== null }, "Sophie suppressed a repeated question and routed the conversation to staff");
    await updateSupportConversationState(conversation.id, { needsAttention: true, needsAttentionReason: describeNeedsAttentionReason(result.requiresStaff ? { kind: "staff_flagged", preCheckCode: result.preCheckCode } : { kind: "stuck_repeating" }) });
    try {
      if (answer) await sendAndLog(personId, conversation.id, customer?.phone ?? null, answer, isCurrent, false, generation, true);
    } finally {
      await holdSmsReplyForStaff(personId, "support");
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

  const statePatch: SupportConversationStatePatch = {
    lastQuestion: result.nextQuestion,
    lastDraft: isStuckRepeating ? (result.reply ?? conversation.lastDraft) : result.reply,
    ...(!isStuckRepeating && result.requiresStaff
        ? { needsAttention: true, needsAttentionReason: describeNeedsAttentionReason({ kind: "staff_flagged", preCheckCode: result.preCheckCode }) }
        : {}),
    ...(conversation.reviewRequested && result.inboundSentiment !== null ? { reviewSentiment: result.inboundSentiment } : {}),
  };
  await updateSupportConversationState(conversation.id, statePatch);

  return result;
}
