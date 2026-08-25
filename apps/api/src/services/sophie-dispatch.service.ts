import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";
import { runSophieTurn, type SophieTurnResult } from "./sophie-conversation.service.js";
import {
  getOrCreateSupportConversation,
  listSupportMessages,
  appendSupportMessage,
  setSupportMessageSentiment,
  updateSupportConversationState,
  toSophiePreviewBody,
  type SupportConversationStatePatch,
} from "./support-conversations.service.js";
import { getSmsProvider } from "../lib/sms-provider.js";
import { logger } from "../lib/logger.js";
import { withPersonLock } from "../lib/db-lock.js";
import { isCustomerSmsDnd, setCustomerSmsDnd } from "./dnd.service.js";
import { describeNeedsAttentionReason } from "../lib/messaging/needs-attention-reason.js";

async function getCustomerContact(personId: string): Promise<{ firstName: string; phone: string | null } | undefined> {
  const [row] = await db.select({ firstName: customersTable.firstName, phone: customersTable.phone }).from(customersTable).where(eq(customersTable.id, personId));
  return row;
}

/**
 * Same fail-soft send+log pattern as Alexis's dispatch (alexis-dispatch.service.ts's
 * sendAndLog), including the same DND-checked-here-not-earlier reasoning — see
 * that function's docstring.
 */
async function sendAndLog(personId: string, conversationId: string, phone: string | null, text: string): Promise<void> {
  if (await isCustomerSmsDnd(personId)) {
    logger.warn({ personId, conversationId }, "outbound Sophie message not sent: customer is do-not-disturb");
    return;
  }

  let providerMessageId: string | null = null;
  if (phone) {
    try {
      const result = await getSmsProvider().sendMessage(phone, text);
      providerMessageId = result.providerMessageId;
    } catch (err) {
      logger.warn({ conversationId, reason: err instanceof Error ? err.message : String(err) }, "outbound Sophie message send failed");
    }
  } else {
    logger.warn({ conversationId }, "outbound Sophie message not sent: no phone number on file");
  }
  await appendSupportMessage(conversationId, "outbound", text, { providerMessageId });
}

/**
 * Full inbound-turn pipeline for Sophie, mirroring processInboundMessage in
 * alexis-dispatch.service.ts: persist the inbound message, run the guardrail
 * loop, tag sentiment, send+log the validated reply, persist updated state.
 *
 * Wrapped in withPersonLock for the same reason as Alexis's dispatch — see
 * the comment there — so a patient double-texting can't race two turns
 * into clobbering each other's conversation-state write.
 */
export async function processInboundSupportMessage(personId: string, inboundBody: string): Promise<SophieTurnResult> {
  return withPersonLock(personId, () => processInboundSupportMessageLocked(personId, inboundBody));
}

async function processInboundSupportMessageLocked(personId: string, inboundBody: string): Promise<SophieTurnResult> {
  const conversation = await getOrCreateSupportConversation(personId);
  const priorMessages = await listSupportMessages(conversation.id);
  const inboundMessage = await appendSupportMessage(conversation.id, "inbound", inboundBody);

  const body = toSophiePreviewBody(conversation, [...priorMessages, inboundMessage]);
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

  if (!result.ok) {
    logger.warn({ personId, conversationId: conversation.id, code: result.code }, "Sophie turn rejected — no outbound message sent");
    await updateSupportConversationState(conversation.id, { needsAttention: true, needsAttentionReason: describeNeedsAttentionReason({ kind: "rejected", code: result.code }) });
    return result;
  }

  await setSupportMessageSentiment(inboundMessage.id, result.inboundSentiment);

  const customer = await getCustomerContact(personId);
  const textsToSend = [result.reply, result.nextQuestion].filter((t): t is string => Boolean(t));
  for (const text of textsToSend) {
    await sendAndLog(personId, conversation.id, customer?.phone ?? null, text);
  }

  // Set DND only after this turn's texts have gone out — see the identical
  // comment in alexis-dispatch.service.ts's processInboundMessageLocked.
  if (result.preCheckCode === "OPT_OUT") {
    await setCustomerSmsDnd(personId, true);
  }

  const statePatch: SupportConversationStatePatch = {
    lastQuestion: result.nextQuestion,
    lastDraft: result.reply,
    ...(result.requiresStaff
      ? { needsAttention: true, needsAttentionReason: describeNeedsAttentionReason({ kind: "staff_flagged", preCheckCode: result.preCheckCode }) }
      : {}),
    ...(conversation.reviewRequested && result.inboundSentiment !== null ? { reviewSentiment: result.inboundSentiment } : {}),
  };
  await updateSupportConversationState(conversation.id, statePatch);

  return result;
}
