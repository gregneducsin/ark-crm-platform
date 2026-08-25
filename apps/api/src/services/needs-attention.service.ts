import { desc, eq, sql } from "drizzle-orm";
import {
  db,
  customersTable,
  conversationsTable,
  conversationMessagesTable,
  supportConversationsTable,
  supportConversationMessagesTable,
  emailConversationsTable,
  emailConversationMessagesTable,
  supportEmailConversationsTable,
  supportEmailConversationMessagesTable,
} from "@luma/db";
import { clearNeedsAttention as clearAlexisSmsAttention } from "./conversations.service.js";
import { clearSupportNeedsAttention as clearSophieSmsAttention } from "./support-conversations.service.js";
import { updateEmailConversationState } from "./email-conversations.service.js";
import { updateSupportEmailConversationState } from "./support-email-conversations.service.js";

/**
 * Unifies the 4 independent needsAttention flags (Alexis SMS, Sophie SMS, Alexis
 * email, Sophie email — each its own table, see the schema docstrings for why
 * they're kept separate rather than a shared "channel" column) into one
 * cross-channel triage view for the dashboard. Nothing here changes how any
 * of the 4 flags get set — this only reads and clears them.
 */
export type NeedsAttentionChannel = "sms" | "email";
export type NeedsAttentionPersona = "alexis" | "sophie";

export interface NeedsAttentionItem {
  readonly conversationId: string;
  readonly channel: NeedsAttentionChannel;
  readonly persona: NeedsAttentionPersona;
  readonly personId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly lastMessagePreview: string | null;
  readonly lastMessageAt: string | null;
  readonly reason: string | null;
}

async function listAlexisSms(): Promise<NeedsAttentionItem[]> {
  const rows = await db
    .select({
      conversationId: conversationsTable.id,
      personId: conversationsTable.personId,
      firstName: customersTable.firstName,
      lastName: customersTable.lastName,
      lastMessageAt: sql<string | null>`(select max(${conversationMessagesTable.createdAt}) from ${conversationMessagesTable} where ${conversationMessagesTable.conversationId} = ${conversationsTable.id})`,
      lastMessagePreview: sql<string | null>`(select ${conversationMessagesTable.body} from ${conversationMessagesTable} where ${conversationMessagesTable.conversationId} = ${conversationsTable.id} order by ${conversationMessagesTable.createdAt} desc limit 1)`,
      reason: conversationsTable.needsAttentionReason,
    })
    .from(conversationsTable)
    .innerJoin(customersTable, eq(customersTable.id, conversationsTable.personId))
    .where(eq(conversationsTable.needsAttention, true));
  return rows.map((r) => ({ ...r, channel: "sms" as const, persona: "alexis" as const }));
}

async function listSophieSms(): Promise<NeedsAttentionItem[]> {
  const rows = await db
    .select({
      conversationId: supportConversationsTable.id,
      personId: supportConversationsTable.personId,
      firstName: customersTable.firstName,
      lastName: customersTable.lastName,
      lastMessageAt: sql<string | null>`(select max(${supportConversationMessagesTable.createdAt}) from ${supportConversationMessagesTable} where ${supportConversationMessagesTable.conversationId} = ${supportConversationsTable.id})`,
      lastMessagePreview: sql<string | null>`(select ${supportConversationMessagesTable.body} from ${supportConversationMessagesTable} where ${supportConversationMessagesTable.conversationId} = ${supportConversationsTable.id} order by ${supportConversationMessagesTable.createdAt} desc limit 1)`,
      reason: supportConversationsTable.needsAttentionReason,
    })
    .from(supportConversationsTable)
    .innerJoin(customersTable, eq(customersTable.id, supportConversationsTable.personId))
    .where(eq(supportConversationsTable.needsAttention, true));
  return rows.map((r) => ({ ...r, channel: "sms" as const, persona: "sophie" as const }));
}

async function listAlexisEmail(): Promise<NeedsAttentionItem[]> {
  const rows = await db
    .select({
      conversationId: emailConversationsTable.id,
      personId: emailConversationsTable.personId,
      firstName: customersTable.firstName,
      lastName: customersTable.lastName,
      lastMessageAt: sql<string | null>`(select max(${emailConversationMessagesTable.createdAt}) from ${emailConversationMessagesTable} where ${emailConversationMessagesTable.conversationId} = ${emailConversationsTable.id})`,
      lastMessagePreview: sql<string | null>`(select ${emailConversationMessagesTable.subject} from ${emailConversationMessagesTable} where ${emailConversationMessagesTable.conversationId} = ${emailConversationsTable.id} order by ${emailConversationMessagesTable.createdAt} desc limit 1)`,
      reason: emailConversationsTable.needsAttentionReason,
    })
    .from(emailConversationsTable)
    .innerJoin(customersTable, eq(customersTable.id, emailConversationsTable.personId))
    .where(eq(emailConversationsTable.needsAttention, true));
  return rows.map((r) => ({ ...r, channel: "email" as const, persona: "alexis" as const }));
}

async function listSophieEmail(): Promise<NeedsAttentionItem[]> {
  const rows = await db
    .select({
      conversationId: supportEmailConversationsTable.id,
      personId: supportEmailConversationsTable.personId,
      firstName: customersTable.firstName,
      lastName: customersTable.lastName,
      lastMessageAt: sql<string | null>`(select max(${supportEmailConversationMessagesTable.createdAt}) from ${supportEmailConversationMessagesTable} where ${supportEmailConversationMessagesTable.conversationId} = ${supportEmailConversationsTable.id})`,
      lastMessagePreview: sql<string | null>`(select ${supportEmailConversationMessagesTable.subject} from ${supportEmailConversationMessagesTable} where ${supportEmailConversationMessagesTable.conversationId} = ${supportEmailConversationsTable.id} order by ${supportEmailConversationMessagesTable.createdAt} desc limit 1)`,
      reason: supportEmailConversationsTable.needsAttentionReason,
    })
    .from(supportEmailConversationsTable)
    .innerJoin(customersTable, eq(customersTable.id, supportEmailConversationsTable.personId))
    .where(eq(supportEmailConversationsTable.needsAttention, true));
  return rows.map((r) => ({ ...r, channel: "email" as const, persona: "sophie" as const }));
}

/** Every flagged conversation across all 4 channels, most recently active first (nulls — no messages yet — last). */
export async function listNeedsAttention(): Promise<NeedsAttentionItem[]> {
  const [alexisSms, sophieSms, alexisEmail, sophieEmail] = await Promise.all([listAlexisSms(), listSophieSms(), listAlexisEmail(), listSophieEmail()]);
  return [...alexisSms, ...sophieSms, ...alexisEmail, ...sophieEmail].sort((a, b) => {
    if (a.lastMessageAt === null) return 1;
    if (b.lastMessageAt === null) return -1;
    return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
  });
}

export interface NeedsAttentionMessage {
  readonly id: string;
  readonly direction: "inbound" | "outbound";
  readonly subject: string | null;
  readonly body: string;
  readonly createdAt: string;
}

/** Read-only recent history for a flagged item, for inline preview in the triage view — reuses the same tables the per-channel pages already read from. */
export async function getNeedsAttentionMessages(channel: NeedsAttentionChannel, persona: NeedsAttentionPersona, conversationId: string): Promise<NeedsAttentionMessage[]> {
  if (channel === "sms" && persona === "alexis") {
    const rows = await db.select().from(conversationMessagesTable).where(eq(conversationMessagesTable.conversationId, conversationId)).orderBy(desc(conversationMessagesTable.createdAt)).limit(10);
    return rows.reverse().map((r) => ({ id: r.id, direction: r.direction, subject: null, body: r.body, createdAt: r.createdAt.toISOString() }));
  }
  if (channel === "sms" && persona === "sophie") {
    const rows = await db
      .select()
      .from(supportConversationMessagesTable)
      .where(eq(supportConversationMessagesTable.conversationId, conversationId))
      .orderBy(desc(supportConversationMessagesTable.createdAt))
      .limit(10);
    return rows.reverse().map((r) => ({ id: r.id, direction: r.direction, subject: null, body: r.body, createdAt: r.createdAt.toISOString() }));
  }
  if (channel === "email" && persona === "alexis") {
    const rows = await db
      .select()
      .from(emailConversationMessagesTable)
      .where(eq(emailConversationMessagesTable.conversationId, conversationId))
      .orderBy(desc(emailConversationMessagesTable.createdAt))
      .limit(10);
    return rows.reverse().map((r) => ({ id: r.id, direction: r.direction, subject: r.subject, body: r.body, createdAt: r.createdAt.toISOString() }));
  }
  const rows = await db
    .select()
    .from(supportEmailConversationMessagesTable)
    .where(eq(supportEmailConversationMessagesTable.conversationId, conversationId))
    .orderBy(desc(supportEmailConversationMessagesTable.createdAt))
    .limit(10);
  return rows.reverse().map((r) => ({ id: r.id, direction: r.direction, subject: r.subject, body: r.body, createdAt: r.createdAt.toISOString() }));
}

/** Dispatches to the right channel/persona's own clear-attention logic — same 4 underlying flags, just one entry point for the unified triage view. */
export async function clearNeedsAttentionItem(channel: NeedsAttentionChannel, persona: NeedsAttentionPersona, conversationId: string): Promise<void> {
  if (channel === "sms" && persona === "alexis") return clearAlexisSmsAttention(conversationId);
  if (channel === "sms" && persona === "sophie") return clearSophieSmsAttention(conversationId);
  if (channel === "email" && persona === "alexis") return updateEmailConversationState(conversationId, { needsAttention: false, needsAttentionReason: null });
  return updateSupportEmailConversationState(conversationId, { needsAttention: false, needsAttentionReason: null });
}
