import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";
import { runSophieTurn, type SophieTurnResult } from "./sophie-conversation.service.js";
import {
  getOrCreateSupportEmailConversation,
  getSupportEmailConversationDetail,
  listSupportEmailMessages,
  appendSupportEmailMessage,
  setSupportEmailMessageSentiment,
  updateSupportEmailConversationState,
  toSupportEmailPreviewBody,
  type SupportEmailConversationStatePatch,
} from "./support-email-conversations.service.js";
import { getEmailProvider } from "../lib/email-provider.js";
import { renderConversationReplyEmail } from "../lib/email/templates.js";
import { buildUnsubscribeUrl } from "../lib/email/unsubscribe.js";
import { logger } from "../lib/logger.js";
import { withPersonLock } from "../lib/db-lock.js";
import { isCustomerEmailDnd, setCustomerEmailDnd } from "./dnd.service.js";
import { describeNeedsAttentionReason } from "../lib/messaging/needs-attention-reason.js";

async function getCustomerContact(personId: string): Promise<{ firstName: string; email: string } | undefined> {
  const [row] = await db.select({ firstName: customersTable.firstName, email: customersTable.email }).from(customersTable).where(eq(customersTable.id, personId));
  return row;
}

function replySubject(originalSubject: string): string {
  return /^re:/i.test(originalSubject.trim()) ? originalSubject : `Re: ${originalSubject}`;
}

const SIGN_OFF = "Sophie at Ark Health";

/**
 * Same randomized-greeting reasoning as alexis-email-dispatch.service.ts's
 * withGreetingAndSignOff — always opening "Hi <name>," reads as templated,
 * so this varies between the full greeting, just the name, or no greeting
 * line at all.
 */
const GREETING_STYLES: ReadonlyArray<(firstName: string) => string> = [
  (name) => (name ? `Hi ${name},` : "Hi,"),
  (name) => (name ? `${name},` : "Hi,"),
  () => "",
];

function withGreetingAndSignOff(firstName: string, bodyText: string): string {
  const name = firstName.trim();
  const greeting = GREETING_STYLES[Math.floor(Math.random() * GREETING_STYLES.length)](name);
  const opening = greeting ? `${greeting}\n\n${bodyText}` : bodyText;
  return `${opening}\n\n— ${SIGN_OFF}`;
}

/** Email twin of sophie-dispatch.service.ts's sendAndLog — same fail-soft and DND-checked-here reasoning as alexis-email-dispatch.service.ts's sendAndLog. */
async function sendAndLog(
  personId: string,
  conversationId: string,
  email: string,
  firstName: string,
  subject: string,
  bodyText: string,
  inReplyTo: string | null,
): Promise<void> {
  if (await isCustomerEmailDnd(personId)) {
    logger.warn({ personId, conversationId }, "outbound Sophie email not sent: customer is do-not-disturb");
    return;
  }

  const signedBody = withGreetingAndSignOff(firstName, bodyText);
  let messageId: string | null = null;
  try {
    const { provider, fromName } = getEmailProvider("sophie");
    const unsubscribeUrl = buildUnsubscribeUrl(personId);
    const html = renderConversationReplyEmail(signedBody, unsubscribeUrl);
    const result = await provider.sendEmail(email, subject, html, {
      fromName,
      inReplyTo: inReplyTo ?? undefined,
      references: inReplyTo ?? undefined,
      unsubscribeUrl,
    });
    messageId = result.messageId;
  } catch (err) {
    logger.warn({ conversationId, reason: err instanceof Error ? err.message : String(err) }, "outbound Sophie email send failed");
  }
  await appendSupportEmailMessage(conversationId, "outbound", subject, signedBody, { messageId, inReplyTo });
}

/**
 * Email twin of sophie-dispatch.service.ts's processInboundSupportMessage —
 * same runSophieTurn guardrail pipeline unchanged, same combined-reply
 * adaptation as alexis-email-dispatch.service.ts (reply + nextQuestion sent
 * as one email, not two).
 */
export async function processInboundSupportEmail(personId: string, subject: string, bodyText: string, messageId: string | null): Promise<SophieTurnResult> {
  return withPersonLock(personId, () => processInboundSupportEmailLocked(personId, subject, bodyText, messageId));
}

async function processInboundSupportEmailLocked(personId: string, subject: string, bodyText: string, messageId: string | null): Promise<SophieTurnResult> {
  const conversation = await getOrCreateSupportEmailConversation(personId);
  const priorMessages = await listSupportEmailMessages(conversation.id);
  const inboundMessage = await appendSupportEmailMessage(conversation.id, "inbound", subject, bodyText, { messageId });

  const body = toSupportEmailPreviewBody(conversation, [...priorMessages, inboundMessage]);
  let result: SophieTurnResult;
  try {
    result = await runSophieTurn(body);
  } catch (err) {
    // Same reasoning as sophie-dispatch.service.ts's (SMS) equivalent catch:
    // anything that escapes runSophieTurn itself isn't a guardrail rejection,
    // but the patient still got silence, so it needs the same staff-visible flag.
    logger.error({ personId, conversationId: conversation.id, reason: err instanceof Error ? err.message : String(err) }, "Sophie email turn threw unexpectedly — no outbound email sent");
    await updateSupportEmailConversationState(conversation.id, { needsAttention: true, needsAttentionReason: describeNeedsAttentionReason({ kind: "exception" }) });
    return { ok: false, code: "UNEXPECTED_ERROR" };
  }

  if (!result.ok) {
    logger.warn({ personId, conversationId: conversation.id, code: result.code }, "Sophie email turn rejected — no outbound email sent");
    await updateSupportEmailConversationState(conversation.id, { needsAttention: true, needsAttentionReason: describeNeedsAttentionReason({ kind: "rejected", code: result.code }) });
    return result;
  }

  await setSupportEmailMessageSentiment(inboundMessage.id, result.inboundSentiment);

  const customer = await getCustomerContact(personId);
  const combinedBody = [result.reply, result.nextQuestion].filter((t): t is string => Boolean(t)).join("\n\n");
  if (combinedBody && customer) {
    await sendAndLog(personId, conversation.id, customer.email, customer.firstName, replySubject(subject), combinedBody, inboundMessage.messageId);
  }

  if (result.preCheckCode === "OPT_OUT") {
    await setCustomerEmailDnd(personId, true);
  }

  const statePatch: SupportEmailConversationStatePatch = {
    lastQuestion: result.nextQuestion,
    lastDraft: result.reply,
    ...(result.requiresStaff
      ? { needsAttention: true, needsAttentionReason: describeNeedsAttentionReason({ kind: "staff_flagged", preCheckCode: result.preCheckCode }) }
      : {}),
    ...(conversation.reviewRequested && result.inboundSentiment !== null ? { reviewSentiment: result.inboundSentiment } : {}),
  };
  await updateSupportEmailConversationState(conversation.id, statePatch);

  return result;
}

export type EmailStaffReplyResult = { readonly sent: true } | { readonly sent: false; readonly reason: "not_found" | "send_failed" };

/**
 * A human-authored reply to an email conversation — email twin of
 * support-conversations.service.ts's sendStaffReply (SMS), same reasoning
 * as alexis-email-dispatch.service.ts's sendEmailStaffReply.
 */
export async function sendEmailStaffReply(conversationId: string, body: string, staffEmail: string): Promise<EmailStaffReplyResult> {
  const detail = await getSupportEmailConversationDetail(conversationId);
  if (!detail) return { sent: false, reason: "not_found" };

  const { customer, messages } = detail;
  const lastMessage = messages.at(-1);
  const subject = lastMessage ? replySubject(lastMessage.subject) : "Message from Ark Health";
  const signedBody = withGreetingAndSignOff(customer.firstName, body);

  let messageId: string | null = null;
  let sendFailed = false;
  try {
    const { provider, fromName } = getEmailProvider("sophie");
    const unsubscribeUrl = buildUnsubscribeUrl(detail.conversation.personId);
    const html = renderConversationReplyEmail(signedBody, unsubscribeUrl);
    const result = await provider.sendEmail(customer.email, subject, html, {
      fromName,
      inReplyTo: lastMessage?.messageId ?? undefined,
      references: lastMessage?.messageId ?? undefined,
      unsubscribeUrl,
    });
    messageId = result.messageId;
  } catch (err) {
    sendFailed = true;
    logger.warn({ conversationId, reason: err instanceof Error ? err.message : String(err) }, "staff email reply send failed");
  }

  await appendSupportEmailMessage(conversationId, "outbound", subject, signedBody, {
    messageId,
    inReplyTo: lastMessage?.messageId ?? null,
    sentBy: "staff",
    sentByStaffEmail: staffEmail,
  });
  if (sendFailed) return { sent: false, reason: "send_failed" };

  await updateSupportEmailConversationState(conversationId, { needsAttention: false, needsAttentionReason: null });
  return { sent: true };
}
