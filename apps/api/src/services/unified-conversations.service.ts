import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  customersTable,
  purchasesTable,
  conversationsTable,
  emailConversationsTable,
  supportConversationsTable,
  supportEmailConversationsTable,
  intakeLinkTokensTable,
  type Conversation,
  type EmailConversation,
  type SupportConversation,
  type SupportEmailConversation,
} from "@luma/db";
import type { ConversationPersona, SalesThreadInfo, SupportThreadInfo, UnifiedConversationSummary, UnifiedMessage } from "@luma/shared";
import * as conversationsService from "./conversations.service.js";
import * as emailConversationsService from "./email-conversations.service.js";
import * as supportConversationsService from "./support-conversations.service.js";
import * as supportEmailConversationsService from "./support-email-conversations.service.js";
import { sendEmailStaffReply as sendAlexisEmailStaffReply } from "./alexis-email-dispatch.service.js";
import { sendEmailStaffReply as sendSophieEmailStaffReply } from "./sophie-email-dispatch.service.js";

/**
 * Reads across all four conversation table-pairs (sales x {sms, email},
 * support x {sms, email}) and presents them as one merged view per
 * customer — replacing the old separate Conversations and Support tabs.
 * The four tables themselves are untouched (still what webhooks/dispatch
 * services write to); this layer only reads and, for replies, routes to
 * whichever of the four existing sendStaffReply-equivalents applies.
 */

interface SummaryRow {
  personId: string;
  firstName: string;
  lastName: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastSentiment: "positive" | "neutral" | "negative" | null;
  needsAttention: boolean;
  leadSource?: "abandoned_cart" | "meta_form";
}

function mergeSummaryRows(target: Map<string, UnifiedConversationSummary>, rows: readonly SummaryRow[], thread: ConversationPersona): void {
  for (const r of rows) {
    const existing = target.get(r.personId);
    const isNewer = !existing?.lastMessageAt || (r.lastMessageAt !== null && r.lastMessageAt > existing.lastMessageAt);
    target.set(r.personId, {
      personId: r.personId,
      firstName: r.firstName,
      lastName: r.lastName,
      lastMessageAt: isNewer ? r.lastMessageAt : (existing?.lastMessageAt ?? null),
      lastMessagePreview: isNewer ? r.lastMessagePreview : (existing?.lastMessagePreview ?? null),
      lastSentiment: isNewer ? r.lastSentiment : (existing?.lastSentiment ?? null),
      needsAttention: Boolean(existing?.needsAttention) || r.needsAttention,
      leadSource: thread === "sales" ? (r.leadSource ?? existing?.leadSource ?? null) : (existing?.leadSource ?? null),
      hasSalesThread: Boolean(existing?.hasSalesThread) || thread === "sales",
      hasSupportThread: Boolean(existing?.hasSupportThread) || thread === "support",
    });
  }
}

/** For the unified Conversations tab: one row per customer with any thread, most recently active first across all four sources. */
export async function listUnifiedConversationSummaries(): Promise<UnifiedConversationSummary[]> {
  const [salesSms, salesEmail, supportSms, supportEmail] = await Promise.all([
    conversationsService.listConversationSummaries(),
    emailConversationsService.listEmailConversationSummaries(),
    supportConversationsService.listSupportConversationSummaries(),
    supportEmailConversationsService.listSupportEmailConversationSummaries(),
  ]);

  const merged = new Map<string, UnifiedConversationSummary>();
  mergeSummaryRows(merged, salesSms, "sales");
  mergeSummaryRows(merged, salesEmail, "sales");
  mergeSummaryRows(merged, supportSms, "support");
  mergeSummaryRows(merged, supportEmail, "support");

  return Array.from(merged.values()).sort((a, b) => {
    if (!a.lastMessageAt && !b.lastMessageAt) return 0;
    if (!a.lastMessageAt) return 1;
    if (!b.lastMessageAt) return -1;
    return b.lastMessageAt.localeCompare(a.lastMessageAt);
  });
}

export interface SalesResponseStats {
  readonly totalContacted: number;
  readonly totalResponded: number;
  readonly responseRate: number;
}

/**
 * Sales-only (support was never covered by this stat on the old
 * Conversations tab either). Grouped by personId across a UNION ALL of both
 * channels' message tables — not a sum of the two channels' own stats,
 * which would double-count anyone contacted on both SMS and email as two
 * separate "contacted" people instead of one.
 */
export async function getSalesResponseStats(): Promise<SalesResponseStats> {
  const rows = await db.execute<{ has_outbound: boolean; has_inbound: boolean }>(sql`
    select bool_or(direction = 'outbound') as has_outbound, bool_or(direction = 'inbound') as has_inbound
    from (
      select c.person_id, m.direction from conversation_messages m join conversations c on c.id = m.conversation_id
      union all
      select c.person_id, m.direction from email_conversation_messages m join email_conversations c on c.id = m.conversation_id
    ) x
    group by person_id
  `);

  const totalContacted = rows.rows.filter((r) => r.has_outbound).length;
  const totalResponded = rows.rows.filter((r) => r.has_outbound && r.has_inbound).length;
  return { totalContacted, totalResponded, responseRate: totalContacted > 0 ? totalResponded / totalContacted : 0 };
}

function mergeSalesThreadInfo(sms: Conversation | null, email: EmailConversation | null, intakeLinkClicked: boolean): SalesThreadInfo | null {
  if (!sms && !email) return null;
  const reasons = [sms?.needsAttention ? sms.needsAttentionReason : null, email?.needsAttention ? email.needsAttentionReason : null].filter(
    (r): r is string => Boolean(r),
  );
  return {
    needsAttention: Boolean(sms?.needsAttention || email?.needsAttention),
    needsAttentionReason: reasons.length > 0 ? reasons.join(" | ") : null,
    leadSource: sms?.leadSource ?? email?.leadSource ?? "abandoned_cart",
    selectedProduct: sms?.selectedProduct ?? email?.selectedProduct ?? null,
    objectionStage: Math.max(sms?.objectionStage ?? 0, email?.objectionStage ?? 0),
    promoOffered: Boolean(sms?.promoOffered || email?.promoOffered),
    linkProvided: Boolean(sms?.linkProvided || email?.linkProvided),
    intakeLinkClicked,
  };
}

/** Whether the most recently minted intake link (see createIntakeLink in intake-links.service.ts) for this person has been clicked. */
async function hasClickedMostRecentIntakeLink(personId: string): Promise<boolean> {
  const [row] = await db
    .select({ clickedAt: intakeLinkTokensTable.clickedAt })
    .from(intakeLinkTokensTable)
    .where(eq(intakeLinkTokensTable.personId, personId))
    .orderBy(desc(intakeLinkTokensTable.createdAt))
    .limit(1);
  return row?.clickedAt != null;
}

function mergeSupportThreadInfo(sms: SupportConversation | null, email: SupportEmailConversation | null): SupportThreadInfo | null {
  if (!sms && !email) return null;
  const reasons = [sms?.needsAttention ? sms.needsAttentionReason : null, email?.needsAttention ? email.needsAttentionReason : null].filter(
    (r): r is string => Boolean(r),
  );
  return {
    needsAttention: Boolean(sms?.needsAttention || email?.needsAttention),
    needsAttentionReason: reasons.length > 0 ? reasons.join(" | ") : null,
    prescriptionWritten: Boolean(sms?.prescriptionWritten || email?.prescriptionWritten),
    orderShipped: Boolean(sms?.orderShipped || email?.orderShipped),
    trackingNumber: sms?.trackingNumber ?? email?.trackingNumber ?? null,
    reviewRequested: Boolean(sms?.reviewRequested || email?.reviewRequested),
    reviewSentiment: sms?.reviewSentiment ?? email?.reviewSentiment ?? null,
  };
}

async function findSalesSmsRow(personId: string): Promise<Conversation | null> {
  const [row] = await db.select().from(conversationsTable).where(eq(conversationsTable.personId, personId));
  return row ?? null;
}

async function findSalesEmailRow(personId: string): Promise<EmailConversation | null> {
  const [row] = await db.select().from(emailConversationsTable).where(eq(emailConversationsTable.personId, personId));
  return row ?? null;
}

async function findSupportSmsRow(personId: string): Promise<SupportConversation | null> {
  const [row] = await db.select().from(supportConversationsTable).where(eq(supportConversationsTable.personId, personId));
  return row ?? null;
}

async function findSupportEmailRow(personId: string): Promise<SupportEmailConversation | null> {
  const [row] = await db.select().from(supportEmailConversationsTable).where(eq(supportEmailConversationsTable.personId, personId));
  return row ?? null;
}

export async function getUnifiedConversationDetail(personId: string): Promise<{
  customer: { id: string; firstName: string; lastName: string; phone: string | null; email: string | null; hasQualifyingPurchase: boolean };
  sales: SalesThreadInfo | null;
  support: SupportThreadInfo | null;
  messages: UnifiedMessage[];
  availableReplyTargets: { persona: ConversationPersona; channel: "sms" | "email" }[];
} | null> {
  const [customer] = await db
    .select({
      id: customersTable.id,
      firstName: customersTable.firstName,
      lastName: customersTable.lastName,
      phone: customersTable.phone,
      email: customersTable.email,
    })
    .from(customersTable)
    .where(eq(customersTable.id, personId));
  if (!customer) return null;

  const [salesSmsRow, salesEmailRow, supportSmsRow, supportEmailRow] = await Promise.all([
    findSalesSmsRow(personId),
    findSalesEmailRow(personId),
    findSupportSmsRow(personId),
    findSupportEmailRow(personId),
  ]);

  if (!salesSmsRow && !salesEmailRow && !supportSmsRow && !supportEmailRow) return null;

  const [purchased, intakeLinkClicked] = await Promise.all([
    db
      .select({ id: purchasesTable.id })
      .from(purchasesTable)
      .where(and(eq(purchasesTable.customerId, personId), eq(purchasesTable.status, "completed")))
      .limit(1)
      .then((rows) => rows[0]),
    hasClickedMostRecentIntakeLink(personId),
  ]);

  const [salesSmsMessages, salesEmailMessages, supportSmsMessages, supportEmailMessages] = await Promise.all([
    salesSmsRow ? conversationsService.listMessages(salesSmsRow.id, 200) : Promise.resolve([]),
    salesEmailRow ? emailConversationsService.listEmailMessages(salesEmailRow.id, 200) : Promise.resolve([]),
    supportSmsRow ? supportConversationsService.listSupportMessages(supportSmsRow.id, 200) : Promise.resolve([]),
    supportEmailRow ? supportEmailConversationsService.listSupportEmailMessages(supportEmailRow.id, 200) : Promise.resolve([]),
  ]);

  const messages: UnifiedMessage[] = [
    ...salesSmsMessages.map(
      (m): UnifiedMessage => ({
        id: m.id,
        persona: "sales",
        channel: "sms",
        direction: m.direction,
        body: m.body,
        sentiment: m.sentiment,
        sentBy: m.sentBy,
        sentByStaffEmail: m.sentByStaffEmail,
        createdAt: m.createdAt.toISOString(),
      }),
    ),
    ...salesEmailMessages.map(
      (m): UnifiedMessage => ({
        id: m.id,
        persona: "sales",
        channel: "email",
        direction: m.direction,
        subject: m.subject,
        body: m.body,
        sentiment: m.sentiment,
        sentBy: m.sentBy,
        sentByStaffEmail: m.sentByStaffEmail,
        createdAt: m.createdAt.toISOString(),
      }),
    ),
    ...supportSmsMessages.map(
      (m): UnifiedMessage => ({
        id: m.id,
        persona: "support",
        channel: "sms",
        direction: m.direction,
        body: m.body,
        sentiment: m.sentiment,
        sentBy: m.sentBy,
        sentByStaffEmail: m.sentByStaffEmail,
        createdAt: m.createdAt.toISOString(),
      }),
    ),
    ...supportEmailMessages.map(
      (m): UnifiedMessage => ({
        id: m.id,
        persona: "support",
        channel: "email",
        direction: m.direction,
        subject: m.subject,
        body: m.body,
        sentiment: m.sentiment,
        sentBy: m.sentBy,
        sentByStaffEmail: m.sentByStaffEmail,
        createdAt: m.createdAt.toISOString(),
      }),
    ),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const availableReplyTargets: { persona: ConversationPersona; channel: "sms" | "email" }[] = [
    ...(salesSmsRow ? [{ persona: "sales" as const, channel: "sms" as const }] : []),
    ...(salesEmailRow ? [{ persona: "sales" as const, channel: "email" as const }] : []),
    ...(supportSmsRow ? [{ persona: "support" as const, channel: "sms" as const }] : []),
    ...(supportEmailRow ? [{ persona: "support" as const, channel: "email" as const }] : []),
  ];

  return {
    customer: {
      id: customer.id,
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone,
      email: customer.email,
      hasQualifyingPurchase: Boolean(purchased),
    },
    sales: mergeSalesThreadInfo(salesSmsRow, salesEmailRow, intakeLinkClicked),
    support: mergeSupportThreadInfo(supportSmsRow, supportEmailRow),
    messages,
    availableReplyTargets,
  };
}

/** Clears every currently-flagged thread for this person in one action — staff reviewing the merged view no longer think in per-channel terms. */
export async function clearAllNeedsAttention(personId: string): Promise<void> {
  const [salesSmsRow, salesEmailRow, supportSmsRow, supportEmailRow] = await Promise.all([
    findSalesSmsRow(personId),
    findSalesEmailRow(personId),
    findSupportSmsRow(personId),
    findSupportEmailRow(personId),
  ]);

  await Promise.all([
    salesSmsRow?.needsAttention ? conversationsService.clearNeedsAttention(salesSmsRow.id) : null,
    salesEmailRow?.needsAttention
      ? emailConversationsService.updateEmailConversationState(salesEmailRow.id, { needsAttention: false, needsAttentionReason: null })
      : null,
    supportSmsRow?.needsAttention ? supportConversationsService.clearSupportNeedsAttention(supportSmsRow.id) : null,
    supportEmailRow?.needsAttention
      ? supportEmailConversationsService.updateSupportEmailConversationState(supportEmailRow.id, { needsAttention: false, needsAttentionReason: null })
      : null,
  ]);
}

export type UnifiedStaffReplyResult = { readonly sent: true } | { readonly sent: false; readonly reason: "not_found" | "no_phone" | "send_failed" };

/** Routes a staff-authored reply to whichever of the four existing send pipelines matches (persona, channel) — never reimplements the send logic itself. */
export async function sendUnifiedStaffReply(
  personId: string,
  persona: ConversationPersona,
  channel: "sms" | "email",
  body: string,
  staffEmail: string,
): Promise<UnifiedStaffReplyResult> {
  if (persona === "sales" && channel === "sms") {
    const row = await findSalesSmsRow(personId);
    if (!row) return { sent: false, reason: "not_found" };
    return conversationsService.sendStaffReply(row.id, body, staffEmail);
  }
  if (persona === "sales" && channel === "email") {
    const row = await findSalesEmailRow(personId);
    if (!row) return { sent: false, reason: "not_found" };
    return sendAlexisEmailStaffReply(row.id, body, staffEmail);
  }
  if (persona === "support" && channel === "sms") {
    const row = await findSupportSmsRow(personId);
    if (!row) return { sent: false, reason: "not_found" };
    return supportConversationsService.sendStaffReply(row.id, body, staffEmail);
  }
  const row = await findSupportEmailRow(personId);
  if (!row) return { sent: false, reason: "not_found" };
  return sendSophieEmailStaffReply(row.id, body, staffEmail);
}
