import { and, eq, lt } from "drizzle-orm";
import { db, emailConversationsTable, supportEmailConversationsTable, emailConversationMessagesTable, supportEmailConversationMessagesTable } from "@luma/db";
import { getEmailProvider, type EmailPersona } from "../lib/email-provider.js";
import { buildUnsubscribeUrl } from "../lib/email/unsubscribe.js";
import { setCustomerEmailDnd } from "./dnd.service.js";
import { interactivePreCheck } from "../lib/messaging/safety.js";

export type ConversationEmailPersona = Exclude<EmailPersona, "system">;

const tables = (persona: ConversationEmailPersona) => persona === "alexis"
  ? { conversations: emailConversationsTable, messages: emailConversationMessagesTable }
  : { conversations: supportEmailConversationsTable, messages: supportEmailConversationMessagesTable };
const REVIEW_REASON = "Email delivery failed or is unconfirmed. Review the email history and provider before sending another reply. No automatic resend was attempted.";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function flagEmailForReview(persona: ConversationEmailPersona, conversationId: string, reason = REVIEW_REASON, tx?: Tx): Promise<void> {
  const { conversations } = tables(persona);
  await (tx ?? db).update(conversations).set({ needsAttention: true, needsAttentionReason: reason }).where(eq(conversations.id, conversationId));
}

/** Inbound identity is independent of RFC Message-ID, which may be missing.
 * Call under the person lock. A retried interrupted turn goes to staff rather
 * than rerunning the model or repeating a potentially accepted reply. */
export async function recordInboundEmail(persona: ConversationEmailPersona, conversationId: string, subject: string, body: string, messageId: string | null, inboundEventId?: string) {
  const { messages, conversations } = tables(persona);
  const identity = inboundEventId ?? messageId;
  if (identity) {
    const [existing] = await db.select().from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.inboundEventId, identity)));
    if (existing) {
      if (!existing.handledAt) await flagEmailForReview(persona, conversationId, "Email processing was interrupted. The incoming message is saved; please review it and reply. It was not automatically processed again.");
      return { message: existing, shouldProcess: false };
    }
  }
  const [message] = await db.insert(messages).values({ conversationId, direction: "inbound", subject, body, messageId, inboundEventId: identity }).returning();
  const [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  const [queued] = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.deliveryStatus, "queued"))).limit(1);
  if (queued) await flagEmailForReview(persona, conversationId);
  // A staff hold must not prevent a clear unsubscribe from taking effect.
  const preCheck = interactivePreCheck(body);
  if ((conversation.needsAttention || queued) && preCheck.blocked && preCheck.code === "OPT_OUT") await setCustomerEmailDnd(conversation.personId, true);
  return { message, shouldProcess: !conversation.needsAttention && !queued };
}

export async function finishInboundEmail(persona: ConversationEmailPersona, personId: string, identity?: string | null) {
  if (!identity) return;
  const { messages, conversations } = tables(persona);
  const [conversation] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.personId, personId));
  if (conversation) await db.update(messages).set({ handledAt: new Date() }).where(and(eq(messages.conversationId, conversation.id), eq(messages.inboundEventId, identity)));
}

export type TrackedEmailResult = { status: "sent"; messageId: string } | { status: "failed" | "unknown" };

/** Save the exact outgoing message before transport. SMTP acceptance is sent,
 * not proof of inbox delivery. Transport exceptions remain unconfirmed. */
export async function sendTrackedEmail(params: {
  persona: ConversationEmailPersona; personId: string; conversationId: string; email: string; subject: string; body: string;
  render: (unsubscribeUrl: string) => string; inReplyTo?: string | null; fromEmailOverride?: string | null;
  sentBy?: "ai" | "staff"; staffEmail?: string;
  /** Approved order/payment notifications still go out when they themselves require staff attention. */
  transactional?: boolean;
}): Promise<TrackedEmailResult> {
  const { persona, personId, conversationId, subject, body, inReplyTo } = params;
  const { messages, conversations } = tables(persona);
  const outbound = await db.transaction(async (tx) => {
    const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).for("update");
    if (!conversation) return null;
    const [queued] = await tx.select({ id: messages.id }).from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.deliveryStatus, "queued"))).limit(1);
    const blocked = Boolean(queued) || (conversation.needsAttention && params.sentBy !== "staff" && !params.transactional);
    if (queued) await flagEmailForReview(persona, conversationId, "Another outgoing email is awaiting confirmation. This reply was saved but not sent; please review the conversation.", tx);
    const [row] = await tx.insert(messages).values({ conversationId, direction: "outbound", subject, body, inReplyTo,
      sentBy: params.sentBy ?? "ai", sentByStaffEmail: params.staffEmail, deliveryStatus: blocked ? "failed" : "queued" }).returning();
    return row;
  });
  if (!outbound || outbound.deliveryStatus === "failed") return { status: "failed" };
  let transportStarted = false;
  try {
    const { provider, fromName } = getEmailProvider(persona);
    const unsubscribeUrl = buildUnsubscribeUrl(personId);
    const html = params.render(unsubscribeUrl);
    transportStarted = true;
    const result = await provider.sendEmail(params.email, subject, html, { fromName, unsubscribeUrl,
      inReplyTo: inReplyTo ?? undefined, references: inReplyTo ?? undefined, fromEmailOverride: params.fromEmailOverride ?? undefined });
    if (!result.messageId) throw new Error("Email acceptance was not confirmed");
    await db.update(messages).set({ deliveryStatus: "sent", messageId: result.messageId, sentAt: new Date() }).where(eq(messages.id, outbound.id));
    return { status: "sent", messageId: result.messageId };
  } catch {
    const status = transportStarted ? "unknown" : "failed";
    await db.transaction(async (tx) => {
      await flagEmailForReview(persona, conversationId, REVIEW_REASON, tx);
      await tx.update(messages).set({ deliveryStatus: status }).where(and(eq(messages.id, outbound.id), eq(messages.deliveryStatus, "queued")));
    });
    return { status };
  }
}

export async function sweepEmailDeliveryTimeouts() {
  for (const persona of ["alexis", "sophie"] as const) {
    const { messages, conversations } = tables(persona);
    const before = new Date(Date.now() - 5 * 60_000);
    const pending = await db.select({ id: messages.id, conversationId: messages.conversationId }).from(messages)
      .where(and(eq(messages.deliveryStatus, "queued"), lt(messages.createdAt, before))).limit(100);
    for (const message of pending) await db.transaction(async (tx) => {
      await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, message.conversationId)).for("update");
      const [changed] = await tx.update(messages).set({ deliveryStatus: "unknown" })
        .where(and(eq(messages.id, message.id), eq(messages.deliveryStatus, "queued"))).returning({ id: messages.id });
      if (changed) await flagEmailForReview(persona, message.conversationId, REVIEW_REASON, tx);
    });
  }
}
