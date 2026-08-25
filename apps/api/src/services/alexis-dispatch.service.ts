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
  type ConversationStatePatch,
} from "./conversations.service.js";
import { getSmsProvider } from "../lib/sms-provider.js";
import { logger } from "../lib/logger.js";
import { withPersonLock } from "../lib/db-lock.js";
import { isCustomerSmsDnd, setCustomerSmsDnd } from "./dnd.service.js";
import { scheduleObjectionReengagement } from "./objection-reengagement.service.js";
import { describeNeedsAttentionReason } from "../lib/messaging/needs-attention-reason.js";

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
 */
async function sendAndLog(personId: string, conversationId: string, phone: string | null, text: string): Promise<void> {
  if (await isCustomerSmsDnd(personId)) {
    logger.warn({ personId, conversationId }, "outbound Alexis message not sent: customer is do-not-disturb");
    return;
  }

  let providerMessageId: string | null = null;
  if (phone) {
    try {
      const result = await getSmsProvider().sendMessage(phone, text);
      providerMessageId = result.providerMessageId;
    } catch (err) {
      logger.warn({ conversationId, reason: err instanceof Error ? err.message : String(err) }, "outbound Alexis message send failed");
    }
  } else {
    logger.warn({ conversationId }, "outbound Alexis message not sent: no phone number on file");
  }
  await appendMessage(conversationId, "outbound", text, { providerMessageId });
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
): Promise<AlexisTurnResult> {
  return withPersonLock(personId, () => processInboundMessageLocked(personId, inboundBody, initialLeadSource));
}

async function processInboundMessageLocked(personId: string, inboundBody: string, initialLeadSource?: "abandoned_cart" | "meta_form"): Promise<AlexisTurnResult> {
  const conversation = initialLeadSource ? await getOrCreateConversation(personId, initialLeadSource) : await getOrCreateConversation(personId);
  const priorMessages = await listMessages(conversation.id);
  const inboundMessage = await appendMessage(conversation.id, "inbound", inboundBody);

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

  const textsToSend = [result.reply, result.nextQuestion].filter((t): t is string => Boolean(t));
  for (const text of textsToSend) {
    await sendAndLog(personId, conversation.id, customer?.phone ?? null, text);
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
    ...(result.requiresStaff
      ? { needsAttention: true, needsAttentionReason: describeNeedsAttentionReason({ kind: "staff_flagged", preCheckCode: result.preCheckCode }) }
      : {}),
  });

  // "No problem, I'll leave it here for whenever you're ready" is a
  // stand-down for THIS conversation, not the end of outreach — see
  // objection-reengagement.service.ts.
  if (result.objectionKey === "think_about_it" && result.objectionStage === 2) {
    await scheduleObjectionReengagement(personId, conversation.leadSource);
  }

  return result;
}
