import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  supportEmailConversationsTable,
  supportEmailConversationMessagesTable,
  customersTable,
  type SupportEmailConversation,
  type SupportEmailConversationMessage,
} from "@luma/db";
import type { SophiePreviewRequestBody } from "../lib/support/types.js";
import { notifySlack } from "../lib/slack.js";

const MAX_HISTORY_MESSAGES = 20;

export interface SupportEmailConversationStatePatch {
  readonly prescriptionWritten?: boolean;
  readonly prescriptionWrittenAt?: Date;
  readonly orderShipped?: boolean;
  readonly orderShippedAt?: Date;
  readonly trackingNumber?: string | null;
  readonly paymentFailed?: boolean;
  readonly paymentFailedAt?: Date;
  readonly reviewRequested?: boolean;
  readonly reviewSentiment?: "positive" | "neutral" | "negative" | null;
  readonly lastQuestion?: string | null;
  readonly pendingTopic?: string | null;
  readonly lastDraft?: string | null;
  readonly needsAttention?: boolean;
  readonly needsAttentionReason?: string | null;
}

/** Email twin of support-conversations.service.ts's getOrCreateSupportConversation — its own table, same one-per-customer behavior. */
export async function getOrCreateSupportEmailConversation(personId: string): Promise<SupportEmailConversation> {
  const [existing] = await db.select().from(supportEmailConversationsTable).where(eq(supportEmailConversationsTable.personId, personId));
  if (existing) return existing;

  const [created] = await db
    .insert(supportEmailConversationsTable)
    .values({ personId })
    .onConflictDoNothing({ target: supportEmailConversationsTable.personId })
    .returning();
  if (created) return created;

  const [row] = await db.select().from(supportEmailConversationsTable).where(eq(supportEmailConversationsTable.personId, personId));
  return row;
}

/** See support-conversations.service.ts's updateSupportConversationState for why the "already flagged" check only happens on this one patch shape. */
export async function updateSupportEmailConversationState(conversationId: string, patch: SupportEmailConversationStatePatch): Promise<void> {
  if (patch.needsAttention === true) {
    // Atomic UPDATE ... WHERE needsAttention = false ... RETURNING — see
    // support-conversations.service.ts's updateSupportConversationState for
    // why this can't be a separate read-then-write.
    const [flipped] = await db
      .update(supportEmailConversationsTable)
      .set(patch)
      .where(and(eq(supportEmailConversationsTable.id, conversationId), eq(supportEmailConversationsTable.needsAttention, false)))
      .returning({ personId: supportEmailConversationsTable.personId });
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
    await db.update(supportEmailConversationsTable).set(patch).where(eq(supportEmailConversationsTable.id, conversationId));
    return;
  }
  await db.update(supportEmailConversationsTable).set(patch).where(eq(supportEmailConversationsTable.id, conversationId));
}

export async function appendSupportEmailMessage(
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
): Promise<SupportEmailConversationMessage> {
  const [row] = await db
    .insert(supportEmailConversationMessagesTable)
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

export async function setSupportEmailMessageSentiment(messageId: string, sentiment: "positive" | "neutral" | "negative" | null): Promise<void> {
  if (sentiment === null) return;
  await db.update(supportEmailConversationMessagesTable).set({ sentiment }).where(eq(supportEmailConversationMessagesTable.id, messageId));
}

export async function listSupportEmailMessages(conversationId: string, limit = MAX_HISTORY_MESSAGES): Promise<SupportEmailConversationMessage[]> {
  const rows = await db
    .select()
    .from(supportEmailConversationMessagesTable)
    .where(eq(supportEmailConversationMessagesTable.conversationId, conversationId))
    .orderBy(desc(supportEmailConversationMessagesTable.createdAt))
    .limit(limit);
  return rows.reverse();
}

/** Email twin of support-conversations.service.ts's toSophiePreviewBody — runSophieTurn is channel-agnostic and reused unchanged. */
export function toSupportEmailPreviewBody(conversation: SupportEmailConversation, history: readonly SupportEmailConversationMessage[]): SophiePreviewRequestBody {
  return {
    messages: history.map((m) => ({ direction: m.direction, body: m.body })),
    orderState: {
      prescriptionWritten: conversation.prescriptionWritten,
      orderShipped: conversation.orderShipped,
      trackingNumber: conversation.trackingNumber,
      paymentFailed: conversation.paymentFailed,
    },
    reviewRequested: conversation.reviewRequested,
    lastQuestion: conversation.lastQuestion,
    pendingTopic: conversation.pendingTopic,
    lastDraft: conversation.lastDraft,
  };
}

/** Email twin of support-conversations.service.ts's SupportConversationSummary — same shape, its own table. */
export interface SupportEmailConversationSummary {
  readonly id: string;
  readonly personId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly status: "active" | "closed";
  readonly lastMessageAt: string | null;
  readonly lastMessagePreview: string | null;
  readonly lastSentiment: "positive" | "neutral" | "negative" | null;
  readonly needsAttention: boolean;
}

/** For the dashboard's Support tab, email view: one row per email conversation, most recently active first. */
export async function listSupportEmailConversationSummaries(): Promise<SupportEmailConversationSummary[]> {
  const rows = await db
    .select({
      id: supportEmailConversationsTable.id,
      personId: supportEmailConversationsTable.personId,
      firstName: customersTable.firstName,
      lastName: customersTable.lastName,
      status: supportEmailConversationsTable.status,
      needsAttention: supportEmailConversationsTable.needsAttention,
      lastMessageAt: sql<string | null>`(select max(${supportEmailConversationMessagesTable.createdAt}) from ${supportEmailConversationMessagesTable} where ${supportEmailConversationMessagesTable.conversationId} = ${supportEmailConversationsTable.id})`,
      lastMessagePreview: sql<string | null>`(select ${supportEmailConversationMessagesTable.body} from ${supportEmailConversationMessagesTable} where ${supportEmailConversationMessagesTable.conversationId} = ${supportEmailConversationsTable.id} order by ${supportEmailConversationMessagesTable.createdAt} desc limit 1)`,
      lastSentiment: sql<string | null>`(select ${supportEmailConversationMessagesTable.sentiment} from ${supportEmailConversationMessagesTable} where ${supportEmailConversationMessagesTable.conversationId} = ${supportEmailConversationsTable.id} and ${supportEmailConversationMessagesTable.direction} = 'inbound' order by ${supportEmailConversationMessagesTable.createdAt} desc limit 1)`,
    })
    .from(supportEmailConversationsTable)
    .innerJoin(customersTable, eq(customersTable.id, supportEmailConversationsTable.personId))
    .orderBy(desc(sql`(select max(${supportEmailConversationMessagesTable.createdAt}) from ${supportEmailConversationMessagesTable} where ${supportEmailConversationMessagesTable.conversationId} = ${supportEmailConversationsTable.id})`));

  return rows.map((r) => ({ ...r, lastSentiment: r.lastSentiment as SupportEmailConversationSummary["lastSentiment"] }));
}

/** Email twin of support-conversations.service.ts's getSupportConversationDetail — customer.email included, same reasoning as the Alexis-side twin. */
export async function getSupportEmailConversationDetail(
  conversationId: string,
): Promise<{
  conversation: SupportEmailConversation;
  customer: { firstName: string; lastName: string; phone: string | null; email: string };
  messages: SupportEmailConversationMessage[];
} | null> {
  const [row] = await db
    .select({
      conversation: supportEmailConversationsTable,
      firstName: customersTable.firstName,
      lastName: customersTable.lastName,
      phone: customersTable.phone,
      email: customersTable.email,
    })
    .from(supportEmailConversationsTable)
    .innerJoin(customersTable, eq(customersTable.id, supportEmailConversationsTable.personId))
    .where(eq(supportEmailConversationsTable.id, conversationId));
  if (!row) return null;
  const messages = await listSupportEmailMessages(conversationId, 200);
  return { conversation: row.conversation, customer: { firstName: row.firstName, lastName: row.lastName, phone: row.phone, email: row.email }, messages };
}
