import { and, desc, eq, sql } from "drizzle-orm";
import { db, emailConversationsTable, emailConversationMessagesTable, customersTable, type EmailConversation, type EmailConversationMessage } from "@luma/db";
import type { BotPreviewRequestBody } from "../lib/messaging/types.js";
import type { ObjectionKey } from "../lib/messaging/objection-handling.js";
import { notifySlack } from "../lib/slack.js";

const MAX_HISTORY_MESSAGES = 20;

export interface EmailConversationStatePatch {
  readonly selectedProduct?: "semaglutide" | "tirzepatide" | null;
  readonly currentlyTaking?: "yes" | "no" | null;
  readonly wantsProcessExplanation?: "yes" | "no" | null;
  readonly hasTimeForIntake?: "yes" | "no" | null;
  readonly wantsPlanInclusions?: "yes" | "no" | null;
  readonly readyForForm?: "yes" | "no" | null;
  readonly state?: string | null;
  readonly lastQuestion?: string | null;
  readonly pendingTopic?: string | null;
  readonly lastDraft?: string | null;
  readonly objectionStage?: 0 | 1 | 2;
  readonly objectionKey?: ObjectionKey | null;
  readonly linkProvided?: boolean;
  readonly promoOffered?: boolean;
  readonly needsAttention?: boolean;
  readonly needsAttentionReason?: string | null;
}

/**
 * Email twin of conversations.service.ts's getOrCreateConversation — same
 * one-per-customer, create-on-first-use behavior, its own table
 * (emailConversationsTable) so the SMS thread and the email thread for the
 * same person are tracked independently.
 */
export async function getOrCreateEmailConversation(
  personId: string,
  leadSource: "abandoned_cart" | "meta_form" = "abandoned_cart",
  receivingAddress?: string,
): Promise<EmailConversation> {
  const [existing] = await db.select().from(emailConversationsTable).where(eq(emailConversationsTable.personId, personId));
  if (existing) {
    // Keeps this in sync with whichever mailbox the customer most recently
    // wrote to, so a repeat conversation that started on one polled mailbox
    // and continues on another still replies from the right one each time.
    if (receivingAddress && existing.receivingAddress !== receivingAddress) {
      const [updated] = await db
        .update(emailConversationsTable)
        .set({ receivingAddress })
        .where(eq(emailConversationsTable.id, existing.id))
        .returning();
      return updated;
    }
    return existing;
  }

  const [created] = await db
    .insert(emailConversationsTable)
    .values({ personId, leadSource, receivingAddress: receivingAddress ?? null })
    .onConflictDoNothing({ target: emailConversationsTable.personId })
    .returning();
  if (created) return created;

  const [row] = await db.select().from(emailConversationsTable).where(eq(emailConversationsTable.personId, personId));
  return row;
}

/** See support-conversations.service.ts's updateSupportConversationState for why the "already flagged" check only happens on this one patch shape. */
export async function updateEmailConversationState(conversationId: string, patch: EmailConversationStatePatch): Promise<void> {
  if (patch.needsAttention === true) {
    // Atomic UPDATE ... WHERE needsAttention = false ... RETURNING — see
    // support-conversations.service.ts's updateSupportConversationState for
    // why this can't be a separate read-then-write.
    const [flipped] = await db
      .update(emailConversationsTable)
      .set(patch)
      .where(and(eq(emailConversationsTable.id, conversationId), eq(emailConversationsTable.needsAttention, false)))
      .returning({ personId: emailConversationsTable.personId });
    if (flipped) {
      const [customer] = await db
        .select({ firstName: customersTable.firstName, lastName: customersTable.lastName })
        .from(customersTable)
        .where(eq(customersTable.id, flipped.personId));
      if (customer) {
        void notifySlack(`Needs attention (email) — ${customer.firstName} ${customer.lastName}: ${patch.needsAttentionReason ?? "no reason given"}`);
      }
      return;
    }
    await db.update(emailConversationsTable).set(patch).where(eq(emailConversationsTable.id, conversationId));
    return;
  }
  await db.update(emailConversationsTable).set(patch).where(eq(emailConversationsTable.id, conversationId));
}

export async function appendEmailMessage(
  conversationId: string,
  direction: "inbound" | "outbound",
  subject: string,
  body: string,
  opts: {
    sentiment?: "positive" | "neutral" | "negative" | null;
    messageId?: string | null;
    inReplyTo?: string | null;
    sentBy?: "ai" | "staff" | null;
    sentByStaffEmail?: string | null;
  } = {},
): Promise<EmailConversationMessage> {
  const [row] = await db
    .insert(emailConversationMessagesTable)
    .values({
      conversationId,
      direction,
      subject,
      body,
      sentiment: opts.sentiment ?? null,
      messageId: opts.messageId ?? null,
      inReplyTo: opts.inReplyTo ?? null,
      sentBy: opts.sentBy ?? (direction === "outbound" ? "ai" : null),
      sentByStaffEmail: opts.sentByStaffEmail ?? null,
    })
    .returning();
  return row;
}

export async function setEmailMessageSentiment(messageId: string, sentiment: "positive" | "neutral" | "negative" | null): Promise<void> {
  if (sentiment === null) return;
  await db.update(emailConversationMessagesTable).set({ sentiment }).where(eq(emailConversationMessagesTable.id, messageId));
}

export async function listEmailMessages(conversationId: string, limit = MAX_HISTORY_MESSAGES): Promise<EmailConversationMessage[]> {
  const rows = await db
    .select()
    .from(emailConversationMessagesTable)
    .where(eq(emailConversationMessagesTable.conversationId, conversationId))
    .orderBy(desc(emailConversationMessagesTable.createdAt))
    .limit(limit);
  return rows.reverse();
}

/**
 * Builds the shape runAlexisTurn expects, same as conversations.service.ts's
 * toBotPreviewBody — the pure conversation-guardrail logic doesn't know or
 * care which channel a turn came from, so an email turn feeds it exactly
 * the same body shape an SMS turn does. `body.body` here is the plain-text
 * subject+content, not the raw HTML.
 */
export function toEmailPreviewBody(conversation: EmailConversation, history: readonly EmailConversationMessage[], customerFirstName: string | null): BotPreviewRequestBody {
  return {
    messages: history.map((m) => ({ direction: m.direction, body: m.body })),
    leadSource: conversation.leadSource,
    currentSlots: {
      selectedProduct: conversation.selectedProduct,
      currentlyTaking: conversation.currentlyTaking,
      wantsProcessExplanation: conversation.wantsProcessExplanation,
      hasTimeForIntake: conversation.hasTimeForIntake,
      wantsPlanInclusions: conversation.wantsPlanInclusions,
      readyForForm: conversation.readyForForm,
      state: conversation.state,
    },
    lastQuestion: conversation.lastQuestion,
    pendingTopic: conversation.pendingTopic,
    lastDraft: conversation.lastDraft,
    objectionStage: conversation.objectionStage as 0 | 1 | 2,
    objectionKey: conversation.objectionKey,
    linkProvided: conversation.linkProvided,
    promoOffered: conversation.promoOffered,
    customerFirstName,
  };
}

/** Email twin of conversations.service.ts's ConversationSummary — same shape, its own table. */
export interface EmailConversationSummary {
  readonly id: string;
  readonly personId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly leadSource: "abandoned_cart" | "meta_form";
  readonly status: "active" | "closed";
  readonly lastMessageAt: string | null;
  readonly lastMessagePreview: string | null;
  readonly lastSentiment: "positive" | "neutral" | "negative" | null;
  readonly needsAttention: boolean;
}

/** For the dashboard's Conversations tab, email view: one row per email conversation, most recently active first. */
export async function listEmailConversationSummaries(): Promise<EmailConversationSummary[]> {
  const rows = await db
    .select({
      id: emailConversationsTable.id,
      personId: emailConversationsTable.personId,
      firstName: customersTable.firstName,
      lastName: customersTable.lastName,
      leadSource: emailConversationsTable.leadSource,
      status: emailConversationsTable.status,
      needsAttention: emailConversationsTable.needsAttention,
      lastMessageAt: sql<string | null>`(select max(${emailConversationMessagesTable.createdAt}) from ${emailConversationMessagesTable} where ${emailConversationMessagesTable.conversationId} = ${emailConversationsTable.id})`,
      lastMessagePreview: sql<string | null>`(select ${emailConversationMessagesTable.body} from ${emailConversationMessagesTable} where ${emailConversationMessagesTable.conversationId} = ${emailConversationsTable.id} order by ${emailConversationMessagesTable.createdAt} desc limit 1)`,
      lastSentiment: sql<string | null>`(select ${emailConversationMessagesTable.sentiment} from ${emailConversationMessagesTable} where ${emailConversationMessagesTable.conversationId} = ${emailConversationsTable.id} and ${emailConversationMessagesTable.direction} = 'inbound' order by ${emailConversationMessagesTable.createdAt} desc limit 1)`,
    })
    .from(emailConversationsTable)
    .innerJoin(customersTable, eq(customersTable.id, emailConversationsTable.personId))
    .orderBy(desc(sql`(select max(${emailConversationMessagesTable.createdAt}) from ${emailConversationMessagesTable} where ${emailConversationMessagesTable.conversationId} = ${emailConversationsTable.id})`));

  return rows.map((r) => ({ ...r, lastSentiment: r.lastSentiment as EmailConversationSummary["lastSentiment"] }));
}

export interface EmailConversationResponseStats {
  readonly totalContacted: number;
  readonly totalResponded: number;
  readonly responseRate: number;
}

/** Email twin of conversations.service.ts's getConversationResponseStats — same "count each contact once" logic, against the email tables. */
export async function getEmailConversationResponseStats(): Promise<EmailConversationResponseStats> {
  const rows = await db
    .select({
      hasOutbound: sql<boolean>`bool_or(${emailConversationMessagesTable.direction} = 'outbound')`,
      hasInbound: sql<boolean>`bool_or(${emailConversationMessagesTable.direction} = 'inbound')`,
    })
    .from(emailConversationMessagesTable)
    .groupBy(emailConversationMessagesTable.conversationId);

  const totalContacted = rows.filter((r) => r.hasOutbound).length;
  const totalResponded = rows.filter((r) => r.hasOutbound && r.hasInbound).length;
  const responseRate = totalContacted > 0 ? totalResponded / totalContacted : 0;
  return { totalContacted, totalResponded, responseRate };
}

/** Email twin of conversations.service.ts's getConversationDetail — customer.email included since that's the relevant contact identifier for this channel (customer.phone stays too, for display consistency with the SMS detail panel). */
export async function getEmailConversationDetail(
  conversationId: string,
): Promise<{
  conversation: EmailConversation;
  customer: { firstName: string; lastName: string; phone: string | null; email: string };
  messages: EmailConversationMessage[];
} | null> {
  const [row] = await db
    .select({
      conversation: emailConversationsTable,
      firstName: customersTable.firstName,
      lastName: customersTable.lastName,
      phone: customersTable.phone,
      email: customersTable.email,
    })
    .from(emailConversationsTable)
    .innerJoin(customersTable, eq(customersTable.id, emailConversationsTable.personId))
    .where(eq(emailConversationsTable.id, conversationId));
  if (!row) return null;
  const messages = await listEmailMessages(conversationId, 200);
  return { conversation: row.conversation, customer: { firstName: row.firstName, lastName: row.lastName, phone: row.phone, email: row.email }, messages };
}
