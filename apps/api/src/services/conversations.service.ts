import { and, desc, eq, sql } from "drizzle-orm";
import { db, conversationsTable, conversationMessagesTable, customersTable, type Conversation, type ConversationMessage } from "@luma/db";
import type { BotPreviewRequestBody } from "../lib/messaging/types.js";
import type { ObjectionKey } from "../lib/messaging/objection-handling.js";
import { getSmsProvider } from "../lib/sms-provider.js";
import { logger } from "../lib/logger.js";
import { notifySlack } from "../lib/slack.js";

const MAX_HISTORY_MESSAGES = 20;

export interface ConversationStatePatch {
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
 * One conversation per customer. Creates it on first use (opener or inbound
 * reply, whichever comes first). leadSource only takes effect on creation —
 * it's ignored on an existing conversation, since a thread's script doesn't
 * change mid-conversation.
 */
export async function getOrCreateConversation(personId: string, leadSource: "abandoned_cart" | "meta_form" = "abandoned_cart"): Promise<Conversation> {
  const [existing] = await db.select().from(conversationsTable).where(eq(conversationsTable.personId, personId));
  if (existing) return existing;

  const [created] = await db
    .insert(conversationsTable)
    .values({ personId, leadSource })
    .onConflictDoNothing({ target: conversationsTable.personId })
    .returning();
  if (created) return created;

  // Lost a create race to a concurrent call — the row now exists, fetch it.
  const [row] = await db.select().from(conversationsTable).where(eq(conversationsTable.personId, personId));
  return row;
}

/** See support-conversations.service.ts's updateSupportConversationState for why the "already flagged" check only happens on this one patch shape. */
export async function updateConversationState(conversationId: string, patch: ConversationStatePatch): Promise<void> {
  if (patch.needsAttention === true) {
    // A single UPDATE ... WHERE needsAttention = false ... RETURNING, not a
    // separate read-then-write: two webhook-driven calls landing close
    // together for the same conversation would otherwise both read
    // needsAttention: false before either write lands, and both fire the
    // Slack alert. The row lock this UPDATE takes serializes concurrent
    // callers, so only the one that actually flips false -> true gets a row
    // back and alerts.
    const [flipped] = await db
      .update(conversationsTable)
      .set(patch)
      .where(and(eq(conversationsTable.id, conversationId), eq(conversationsTable.needsAttention, false)))
      .returning({ personId: conversationsTable.personId });
    if (flipped) {
      const [customer] = await db
        .select({ firstName: customersTable.firstName, lastName: customersTable.lastName })
        .from(customersTable)
        .where(eq(customersTable.id, flipped.personId));
      if (customer) {
        void notifySlack(`Needs attention (text) — ${customer.firstName} ${customer.lastName}: ${patch.needsAttentionReason ?? "no reason given"}`);
      }
      return;
    }
    // Already flagged (or the conversation doesn't exist) — still apply the rest of the patch, just don't re-alert.
    await db.update(conversationsTable).set(patch).where(eq(conversationsTable.id, conversationId));
    return;
  }
  await db.update(conversationsTable).set(patch).where(eq(conversationsTable.id, conversationId));
}

/** Staff has looked at a flagged conversation — clears the attention flag until the next thing that needs it. */
export async function clearNeedsAttention(conversationId: string): Promise<void> {
  await db.update(conversationsTable).set({ needsAttention: false, needsAttentionReason: null }).where(eq(conversationsTable.id, conversationId));
}

export type StaffReplyResult = { readonly sent: true } | { readonly sent: false; readonly reason: "not_found" | "no_phone" | "send_failed" };

/**
 * A human-authored reply, sent through the same SMS provider Alexis uses and
 * logged into the same conversation timeline the same way a bot reply is
 * (direction: "outbound") — so the CRM history reads as one continuous
 * conversation regardless of who actually wrote each message. Only clears
 * needsAttention on an actual successful send: a send failure means the
 * conversation still needs attention, not less of it.
 *
 * The message is logged even when the send fails (providerMessageId null),
 * same philosophy as sendAndLog in alexis-dispatch.service.ts — a transport
 * failure doesn't erase the fact that this is what staff actually tried to
 * say; the caller still gets sent: false so the UI can show the failure.
 */
export async function sendStaffReply(conversationId: string, body: string, staffEmail: string): Promise<StaffReplyResult> {
  const detail = await getConversationDetail(conversationId);
  if (!detail) return { sent: false, reason: "not_found" };
  if (!detail.customer.phone) return { sent: false, reason: "no_phone" };

  let providerMessageId: string | null = null;
  let sendFailed = false;
  try {
    const result = await getSmsProvider().sendMessage(detail.customer.phone, body);
    providerMessageId = result.providerMessageId;
  } catch (err) {
    sendFailed = true;
    logger.warn({ conversationId, reason: err instanceof Error ? err.message : String(err) }, "staff reply send failed");
  }

  await appendMessage(conversationId, "outbound", body, { providerMessageId, sentBy: "staff", sentByStaffEmail: staffEmail });
  if (sendFailed) return { sent: false, reason: "send_failed" };

  await clearNeedsAttention(conversationId);
  return { sent: true };
}

export async function appendMessage(
  conversationId: string,
  direction: "inbound" | "outbound",
  body: string,
  opts: {
    sentiment?: "positive" | "neutral" | "negative" | null;
    providerMessageId?: string | null;
    sentBy?: "ai" | "staff" | null;
    sentByStaffEmail?: string | null;
  } = {},
): Promise<ConversationMessage> {
  const [row] = await db
    .insert(conversationMessagesTable)
    .values({
      conversationId,
      direction,
      body,
      sentiment: opts.sentiment ?? null,
      providerMessageId: opts.providerMessageId ?? null,
      sentBy: opts.sentBy ?? (direction === "outbound" ? "ai" : null),
      sentByStaffEmail: opts.sentByStaffEmail ?? null,
    })
    .returning();
  return row;
}

export async function setMessageSentiment(messageId: string, sentiment: "positive" | "neutral" | "negative" | null): Promise<void> {
  if (sentiment === null) return;
  await db.update(conversationMessagesTable).set({ sentiment }).where(eq(conversationMessagesTable.id, messageId));
}

export async function listMessages(conversationId: string, limit = MAX_HISTORY_MESSAGES): Promise<ConversationMessage[]> {
  const rows = await db
    .select()
    .from(conversationMessagesTable)
    .where(eq(conversationMessagesTable.conversationId, conversationId))
    .orderBy(desc(conversationMessagesTable.createdAt))
    .limit(limit);
  return rows.reverse();
}

/** Builds the shape runAlexisTurn expects from persisted conversation state + recent history. */
export function toBotPreviewBody(conversation: Conversation, history: readonly ConversationMessage[], customerFirstName: string | null): BotPreviewRequestBody {
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

export interface ConversationSummary {
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

/** For the dashboard's Conversations tab: one row per conversation, most recently active first. */
export async function listConversationSummaries(): Promise<ConversationSummary[]> {
  const rows = await db
    .select({
      id: conversationsTable.id,
      personId: conversationsTable.personId,
      firstName: customersTable.firstName,
      lastName: customersTable.lastName,
      leadSource: conversationsTable.leadSource,
      status: conversationsTable.status,
      needsAttention: conversationsTable.needsAttention,
      lastMessageAt: sql<string | null>`(select max(${conversationMessagesTable.createdAt}) from ${conversationMessagesTable} where ${conversationMessagesTable.conversationId} = ${conversationsTable.id})`,
      lastMessagePreview: sql<string | null>`(select ${conversationMessagesTable.body} from ${conversationMessagesTable} where ${conversationMessagesTable.conversationId} = ${conversationsTable.id} order by ${conversationMessagesTable.createdAt} desc limit 1)`,
      lastSentiment: sql<string | null>`(select ${conversationMessagesTable.sentiment} from ${conversationMessagesTable} where ${conversationMessagesTable.conversationId} = ${conversationsTable.id} and ${conversationMessagesTable.direction} = 'inbound' order by ${conversationMessagesTable.createdAt} desc limit 1)`,
    })
    .from(conversationsTable)
    .innerJoin(customersTable, eq(customersTable.id, conversationsTable.personId))
    .orderBy(desc(sql`(select max(${conversationMessagesTable.createdAt}) from ${conversationMessagesTable} where ${conversationMessagesTable.conversationId} = ${conversationsTable.id})`));

  return rows.map((r) => ({ ...r, lastSentiment: r.lastSentiment as ConversationSummary["lastSentiment"] }));
}

export interface ConversationResponseStats {
  readonly totalContacted: number;
  readonly totalResponded: number;
  /** 0..1. 0 when totalContacted is 0 (nobody to divide by, not "0% response"). */
  readonly responseRate: number;
}

/**
 * Response rate across all contacts, each contact counted once regardless of
 * how many messages went back and forth — not a per-message rate. "Contacted"
 * means we sent at least one outbound message; "responded" means that same
 * contact sent at least one inbound message back. Grouped directly on
 * conversation_messages (not a correlated subquery against conversations) so
 * every column reference is unambiguous within the single table in scope.
 */
export async function getConversationResponseStats(): Promise<ConversationResponseStats> {
  const rows = await db
    .select({
      hasOutbound: sql<boolean>`bool_or(${conversationMessagesTable.direction} = 'outbound')`,
      hasInbound: sql<boolean>`bool_or(${conversationMessagesTable.direction} = 'inbound')`,
    })
    .from(conversationMessagesTable)
    .groupBy(conversationMessagesTable.conversationId);

  const totalContacted = rows.filter((r) => r.hasOutbound).length;
  const totalResponded = rows.filter((r) => r.hasOutbound && r.hasInbound).length;
  const responseRate = totalContacted > 0 ? totalResponded / totalContacted : 0;
  return { totalContacted, totalResponded, responseRate };
}

export async function getConversationDetail(
  conversationId: string,
): Promise<{ conversation: Conversation; customer: { firstName: string; lastName: string; phone: string | null }; messages: ConversationMessage[] } | null> {
  const [row] = await db
    .select({
      conversation: conversationsTable,
      firstName: customersTable.firstName,
      lastName: customersTable.lastName,
      phone: customersTable.phone,
    })
    .from(conversationsTable)
    .innerJoin(customersTable, eq(customersTable.id, conversationsTable.personId))
    .where(eq(conversationsTable.id, conversationId));
  if (!row) return null;
  const messages = await listMessages(conversationId, 200);
  return { conversation: row.conversation, customer: { firstName: row.firstName, lastName: row.lastName, phone: row.phone }, messages };
}
