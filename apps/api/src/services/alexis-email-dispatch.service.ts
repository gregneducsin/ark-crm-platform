import { hasConfirmedIntakeLink } from "./intake-link-delivery.service.js";
import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";
import { runAlexisTurn, type AlexisTurnResult } from "./alexis-conversation.service.js";
import {
  getOrCreateEmailConversation,
  getEmailConversationDetail,
  listEmailMessages,
  setEmailMessageSentiment,
  updateEmailConversationState,
  toEmailPreviewBody,
  type EmailConversationStatePatch,
} from "./email-conversations.service.js";
import { sendTrackedEmail, recordInboundEmail, finishInboundEmail } from "./email-delivery.service.js";
import { renderConversationReplyEmail } from "../lib/email/templates.js";
import { logger } from "../lib/logger.js";
import { withPersonLock } from "../lib/db-lock.js";
import { isCustomerEmailDnd, setCustomerEmailDnd } from "./dnd.service.js";
import { scheduleObjectionReengagement } from "./objection-reengagement.service.js";
import { describeNeedsAttentionReason } from "../lib/messaging/needs-attention-reason.js";

async function getCustomerContact(personId: string): Promise<{ firstName: string; email: string } | undefined> {
  const [row] = await db.select({ firstName: customersTable.firstName, email: customersTable.email }).from(customersTable).where(eq(customersTable.id, personId));
  return row;
}

function replySubject(originalSubject: string): string {
  return /^re:/i.test(originalSubject.trim()) ? originalSubject : `Re: ${originalSubject}`;
}

const SIGN_OFF = "Alexis at Ark Health";

/**
 * Unlike a text, an email reads as unfinished without a sign-off — Claude
 * drafts only the substantive reply body (same as it does for SMS), so this
 * wraps it, not the model. The greeting itself is randomized across a few
 * natural styles (full "Hi <name>,", just the name, or no greeting line at
 * all) rather than always "Hi <name>," on every single email — a real person
 * doesn't open every reply in a thread the same way, and always repeating
 * the same opener reads as templated.
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

/**
 * Reserves a threaded reply before transport and records the delivery outcome.
 * Failed or unconfirmed replies remain visible for staff review. DND is checked here, not earlier
 * in the pipeline, for the identical reason documented there: an OPT_OUT
 * confirmation reply must still go out before the flag it's about to set
 * would otherwise block it.
 */
async function sendAndLog(
  personId: string,
  conversationId: string,
  email: string,
  firstName: string,
  subject: string,
  bodyText: string,
  inReplyTo: string | null,
  fromEmailOverride: string | null,
): Promise<void> {
  if (await isCustomerEmailDnd(personId)) {
    logger.warn({ personId, conversationId }, "outbound Alexis email not sent: customer is do-not-disturb");
    return;
  }

  const signedBody = withGreetingAndSignOff(firstName, bodyText);
  await sendTrackedEmail({ persona: "alexis", personId, conversationId, email, subject, body: signedBody,
    render: (url) => renderConversationReplyEmail(signedBody, url), inReplyTo, fromEmailOverride });
}

/**
 * Email twin of alexis-dispatch.service.ts's processInboundMessage — same
 * guardrail pipeline (runAlexisTurn, unchanged), same withPersonLock
 * serialization reasoning, its own email conversation table. The one real
 * adaptation for the channel: SMS sends reply and nextQuestion as two
 * separate texts; email combines them into one message body, since a
 * two-email reply to a single inbound email reads as broken, not as two
 * conversational beats the way two quick texts do.
 */
export async function processInboundEmail(
  personId: string,
  subject: string,
  bodyText: string,
  messageId: string | null,
  initialLeadSource?: "abandoned_cart" | "meta_form",
  receivingAddress?: string,
  inboundEventId?: string,
): Promise<AlexisTurnResult> {
  return withPersonLock(personId, async () => {
    const result = await processInboundEmailLocked(personId, subject, bodyText, messageId, initialLeadSource, receivingAddress, inboundEventId);
    await finishInboundEmail("alexis", personId, inboundEventId ?? messageId);
    return result;
  });
}

async function processInboundEmailLocked(
  personId: string,
  subject: string,
  bodyText: string,
  messageId: string | null,
  initialLeadSource?: "abandoned_cart" | "meta_form",
  receivingAddress?: string,
  inboundEventId?: string,
): Promise<AlexisTurnResult> {
  const conversation = await getOrCreateEmailConversation(personId, initialLeadSource, receivingAddress);
  const priorMessages = await listEmailMessages(conversation.id);
  const recorded = await recordInboundEmail("alexis", conversation.id, subject, bodyText, messageId, inboundEventId);
  if (!recorded.shouldProcess) return { ok: false, code: "EMAIL_REVIEW_OR_DUPLICATE" };
  const inboundMessage = recorded.message;

  const emailCustomer = await getCustomerContact(personId);
  const customerFirstName = emailCustomer && emailCustomer.firstName && emailCustomer.firstName !== "Unknown" ? emailCustomer.firstName : null;

  const linkProvided = await hasConfirmedIntakeLink(personId, priorMessages.map(m => ({ ...m, deliveryStatus: m.deliveryStatus ?? (m.messageId ? "sent" : null) })));
  const body = toEmailPreviewBody({ ...conversation, linkProvided }, [...priorMessages, inboundMessage], customerFirstName);
  let result: AlexisTurnResult;
  try {
    result = await runAlexisTurn(personId, body);
  } catch (err) {
    // Same reasoning as alexis-dispatch.service.ts's (SMS) equivalent catch:
    // anything that escapes runAlexisTurn itself (e.g. a DB failure minting
    // the intake link on send_form) isn't a guardrail rejection, but the
    // customer still got silence, so it needs the same staff-visible flag.
    logger.error({ personId, conversationId: conversation.id, reason: err instanceof Error ? err.message : String(err) }, "Alexis email turn threw unexpectedly — no outbound email sent");
    await updateEmailConversationState(conversation.id, { needsAttention: true, needsAttentionReason: describeNeedsAttentionReason({ kind: "exception" }) });
    return { ok: false, code: "UNEXPECTED_ERROR" };
  }

  if (!result.ok) {
    logger.warn({ personId, conversationId: conversation.id, code: result.code }, "Alexis email turn rejected — no outbound email sent");
    await updateEmailConversationState(conversation.id, { needsAttention: true, needsAttentionReason: describeNeedsAttentionReason({ kind: "rejected", code: result.code }) });
    return result;
  }

  await setEmailMessageSentiment(inboundMessage.id, result.inboundSentiment);

  // Guarded the same way as alexis-dispatch.service.ts's (SMS) equivalent —
  // trust but verify even though the prompt already tells Claude not to
  // report this once customerFirstName is known. Written before the re-fetch
  // below so this very reply's greeting already uses the name just learned,
  // instead of "Unknown."
  if (result.learnedFirstName && customerFirstName === null) {
    await db.update(customersTable).set({ firstName: result.learnedFirstName }).where(eq(customersTable.id, personId));
  }

  const customer = await getCustomerContact(personId);
  const combinedBody = [result.reply, result.nextQuestion].filter((t): t is string => Boolean(t)).join("\n\n");
  if (combinedBody && customer) {
    await sendAndLog(personId, conversation.id, customer.email, customer.firstName, replySubject(subject), combinedBody, inboundMessage.messageId, conversation.receivingAddress);
  }

  // Set DND only after this turn's reply has gone out — see sendAndLog's docstring.
  if (result.preCheckCode === "OPT_OUT") {
    await setCustomerEmailDnd(personId, true);
  }

  const slotPatch: EmailConversationStatePatch = {};
  for (const [key, value] of Object.entries(result.validatedSlotUpdates)) {
    (slotPatch as Record<string, unknown>)[key] = value;
  }

  await updateEmailConversationState(conversation.id, {
    ...slotPatch,
    lastQuestion: result.nextQuestion,
    lastDraft: result.reply,
    objectionStage: result.objectionStage,
    objectionKey: result.objectionKey,
    linkProvided: await hasConfirmedIntakeLink(personId, (await listEmailMessages(conversation.id)).map(m => ({ ...m, deliveryStatus: m.deliveryStatus ?? (m.messageId ? "sent" : null) }))),
    promoOffered: result.promoOffered,
    ...(result.requiresStaff
      ? { needsAttention: true, needsAttentionReason: describeNeedsAttentionReason({ kind: "staff_flagged", preCheckCode: result.preCheckCode }) }
      : {}),
  });

  // Same follow-through as the SMS side — see the identical comment in
  // alexis-dispatch.service.ts.
  if ((result.objectionKey === "think_about_it" || result.objectionKey === "price") && result.objectionStage === 2) {
    await scheduleObjectionReengagement(personId, conversation.leadSource);
  }

  return result;
}

export type EmailStaffReplyResult = { readonly sent: true } | { readonly sent: false; readonly reason: "not_found" | "send_failed" };

/**
 * A human-authored reply to an email conversation — email twin of
 * conversations.service.ts's sendStaffReply (SMS): logs the message
 * regardless of send outcome, only clears needsAttention on an actual
 * successful send. Threads off the most recent message in the thread
 * (inbound or outbound, whichever is last) and gets the same
 * greeting/sign-off wrap sendAndLog gives an AI-drafted reply, so a staff
 * reply reads identically to a bot one in the customer's inbox.
 */
export async function sendEmailStaffReply(conversationId: string, body: string, staffEmail: string): Promise<EmailStaffReplyResult> {
  const detail = await getEmailConversationDetail(conversationId);
  if (!detail) return { sent: false, reason: "not_found" };
  return withPersonLock(detail.conversation.personId, () => sendEmailStaffReplyLocked(conversationId, body, staffEmail));
}

async function sendEmailStaffReplyLocked(conversationId: string, body: string, staffEmail: string): Promise<EmailStaffReplyResult> {
  const detail = await getEmailConversationDetail(conversationId);
  if (!detail) return { sent: false, reason: "not_found" };

  const { customer, messages } = detail;
  const lastMessage = messages.at(-1);
  const threadMessage = [...messages].reverse().find((message) => message.messageId);
  const subject = lastMessage ? replySubject(lastMessage.subject) : "Message from Ark Health";
  const signedBody = withGreetingAndSignOff(customer.firstName, body);

  const result = await sendTrackedEmail({ persona: "alexis", personId: detail.conversation.personId, conversationId,
    email: customer.email, subject, body: signedBody, render: (url) => renderConversationReplyEmail(signedBody, url),
    inReplyTo: threadMessage?.messageId, fromEmailOverride: detail.conversation.receivingAddress, sentBy: "staff", staffEmail });
  if (result.status !== "sent") return { sent: false, reason: "send_failed" };

  await updateEmailConversationState(conversationId, { needsAttention: false, needsAttentionReason: null });
  return { sent: true };
}
