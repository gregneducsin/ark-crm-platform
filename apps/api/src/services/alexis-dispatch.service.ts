import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";
import { runAlexisTurn, type AlexisTurnResult } from "./alexis-conversation.service.js";
import {
  getOrCreateConversation,
  listMessages,
  appendMessage,
  setMessageSentiment,
  updateConversationState,
  toBotPreviewBody,
  countRecentOutboundMessages,
  type ConversationStatePatch,
} from "./conversations.service.js";
import { getSmsProvider } from "../lib/sms-provider.js";
import { logger } from "../lib/logger.js";
import { withPersonLock } from "../lib/db-lock.js";
import { isCustomerSmsDnd, setCustomerSmsDnd } from "./dnd.service.js";
import { isSalesSmsPaused } from "../lib/sales-sms.js";
import { scheduleObjectionReengagement } from "./objection-reengagement.service.js";
import { describeNeedsAttentionReason } from "../lib/messaging/needs-attention-reason.js";
import { countTrailingRepeatQuestions } from "../lib/messaging/repeat-question.js";

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
 * DND is checked here rather than earlier in the pipeline, so a customer's
 * own OPT_OUT confirmation reply still goes out: processInboundMessageLocked
 * sends this turn's texts before it flips the DND flag, so this check only
 * ever blocks a *later* turn's sends, never the opt-out confirmation itself.
 *
 * The sales-SMS pause is checked here too — this is the one chokepoint every
 * Alexis send passes through, so gating it here covers every automated turn
 * and every reply, with no exception for the opt-out confirmation (unlike
 * DND above): while paused, nothing Alexis would say goes out at all.
 */
async function sendAndLog(personId: string, conversationId: string, phone: string | null, text: string): Promise<void> {
  if (isSalesSmsPaused()) {
    logger.warn({ personId, conversationId }, "outbound Alexis message not sent: sales SMS is paused");
    return;
  }

  if (await isCustomerSmsDnd(personId)) {
    logger.warn({ personId, conversationId }, "outbound Alexis message not sent: customer is do-not-disturb");
    return;
  }

  const recentSends = await countRecentOutboundMessages(conversationId, SEND_BURST_WINDOW_MS);
  if (recentSends >= SEND_BURST_LIMIT) {
    logger.warn({ personId, conversationId, recentSends }, "outbound Alexis message not sent: send-burst limit reached");
    return;
  }

  let providerMessageId: string | null = null;
  let deliveryStatus: "sent" | "failed" = "failed";
  if (phone) {
    try {
      const result = await getSmsProvider().sendMessage(phone, text);
      providerMessageId = result.providerMessageId;
      deliveryStatus = "sent";
    } catch (err) {
      logger.warn({ conversationId, reason: err instanceof Error ? err.message : String(err) }, "outbound Alexis message send failed");
    }
  } else {
    logger.warn({ conversationId }, "outbound Alexis message not sent: no phone number on file");
  }
  await appendMessage(conversationId, "outbound", text, { providerMessageId, deliveryStatus });
}

/**
 * Full inbound-turn pipeline: persist the inbound message, run it through
 * the guardrail loop, tag its sentiment, send (and log) whatever Alexis's
 * validated reply is, and persist the updated conversation state. This is
 * the real dispatch path — it calls the SMS provider for real, same as the
 * follow-up pipeline, and fails the same way (cleanly, loudly, not silently)
 * until a provider is actually configured.
 *
 * Wrapped in withPersonLock: a customer double-texting sends two inbound
 * webhooks in quick succession, and without serialization both calls would
 * read the same stale conversation state, run independent Claude turns
 * blind to each other's inbound message, and race to write the final state
 * back — losing whichever slot updates the earlier call made. The lock
 * makes the second call wait for the first to fully finish (Claude call,
 * sends, and state write) before it starts, so it always builds its turn on
 * top of what the first one actually did.
 */
export async function processInboundMessage(
  personId: string,
  inboundBody: string,
  initialLeadSource?: "abandoned_cart" | "meta_form",
  mediaUrls?: string[],
): Promise<AlexisTurnResult> {
  return withPersonLock(personId, () => processInboundMessageLocked(personId, inboundBody, initialLeadSource, mediaUrls));
}

async function processInboundMessageLocked(personId: string, inboundBody: string, initialLeadSource?: "abandoned_cart" | "meta_form", mediaUrls?: string[]): Promise<AlexisTurnResult> {
  const conversation = initialLeadSource ? await getOrCreateConversation(personId, initialLeadSource) : await getOrCreateConversation(personId);
  const priorMessages = await listMessages(conversation.id);
  const inboundMessage = await appendMessage(conversation.id, "inbound", inboundBody, { mediaUrls });

  const customer = await getCustomerContact(personId);
  // "Unknown" is the placeholder a webhook-created customer row gets when no
  // name was ever provided (see findOrCreateCustomerByExternalIdentity) — not
  // a real name, so it resolves to null the same as no firstName at all.
  const customerFirstName = customer && customer.firstName && customer.firstName !== "Unknown" ? customer.firstName : null;

  const body = toBotPreviewBody(conversation, [...priorMessages, inboundMessage], customerFirstName);
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
  // one Alexis has already asked (reworded) several times in a row without
  // the conversation moving forward? Real incident (Luma, same architecture,
  // ported here): a customer kept answering a "which plan length" question
  // in different words, none of which the bot recognized as resolving it,
  // so it just re-asked a reworded version turn after turn — eventually
  // ~20 real texts to one customer. Every individual turn was a legitimate,
  // guardrail-approved reply to a real inbound message, so no single-turn or
  // volume-based check could catch this — only recognizing the repetition
  // itself can.
  const recentQuestions = priorMessages.filter((m) => m.direction === "outbound" && m.body.trim().endsWith("?")).map((m) => m.body);
  const repeatStreak = countTrailingRepeatQuestions(recentQuestions, result.nextQuestion);
  const isStuckRepeating = repeatStreak >= REPEAT_QUESTION_THRESHOLD - 1;

  if (isStuckRepeating) {
    logger.warn({ personId, conversationId: conversation.id, repeatStreak }, "Alexis stopped auto-replying: asked essentially the same question repeatedly with no progress");
  } else {
    const textsToSend = [result.reply, result.nextQuestion].filter((t): t is string => Boolean(t));
    for (const text of textsToSend) {
      await sendAndLog(personId, conversation.id, customer?.phone ?? null, text);
    }
  }

  // Set DND only after this turn's texts have gone out, so the OPT_OUT
  // confirmation reply above isn't itself blocked by the flag it's about to set.
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
    lastDraft: result.reply,
    objectionStage: result.objectionStage,
    objectionKey: result.objectionKey,
    linkProvided: result.linkProvided,
    promoOffered: result.promoOffered,
    ...(isStuckRepeating
      ? { needsAttention: true, needsAttentionReason: describeNeedsAttentionReason({ kind: "stuck_repeating" }) }
      : result.requiresStaff
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
