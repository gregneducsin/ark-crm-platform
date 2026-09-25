import { and, eq, lt, sql } from "drizzle-orm";
import {
  db, conversationMessagesTable, supportConversationMessagesTable, unmatchedSmsMessagesTable,
  conversationsTable, supportConversationsTable, smsDeliveryReceiptsTable, smsReplyWorkTable, customersTable,
} from "@luma/db";
import { getSmsProvider } from "../lib/sms-provider.js";
import { assertPhoneSmsAllowed, SmsOptOutError } from "../lib/sms-opt-out.js";
import { assertScheduledSmsTime, SmsQuietHoursError } from "../lib/send-window.js";
import { isSalesSmsPaused, SalesSmsPausedError } from "../lib/sales-sms.js";

export type SmsPersona = "sales" | "support";
export type SmsInboundMetadata = { providerMessageId?: string | null; createdAt?: Date };
export type SmsDeliveryStatus = "queued" | "sent" | "delivered" | "read" | "failed" | "unknown";
const TIMEOUT_MS = 5 * 60 * 1000;
const messageTable = (persona: SmsPersona) => persona === "sales" ? conversationMessagesTable : supportConversationMessagesTable;
const workKey = (personId: string, persona: SmsPersona) => and(eq(smsReplyWorkTable.personId, personId), eq(smsReplyWorkTable.persona, persona));

/** Persist incoming text and its pending turn together; a restart cannot lose the work. */
export async function recordSmsInbound(personId: string, persona: SmsPersona, conversationId: string, body: string, mediaUrls?: string[], metadata: SmsInboundMetadata = {}) {
  return db.transaction(async (tx) => {
    // Serialize inbound persistence with a scheduled send's final eligibility check.
    await tx.select({ id: customersTable.id }).from(customersTable).where(eq(customersTable.id, personId)).for("update");
    const [message] = await tx.insert(messageTable(persona)).values({
      conversationId, direction: "inbound", body, mediaUrls,
      providerMessageId: metadata.providerMessageId, createdAt: metadata.createdAt,
    }).returning();
    await tx.insert(smsReplyWorkTable).values({ personId, persona }).onConflictDoUpdate({
      target: [smsReplyWorkTable.personId, smsReplyWorkTable.persona],
      // Keep a human-review hold until staff explicitly replies.
      set: { generation: sql`gen_random_uuid()`, updatedAt: new Date() },
    });
    return message;
  });
}

export async function getSmsReplyWork(personId: string, persona: SmsPersona) {
  const [work] = await db.select().from(smsReplyWorkTable).where(workKey(personId, persona));
  return work;
}
export async function finishSmsReplyWork(personId: string, persona: SmsPersona, generation: string) {
  await db.delete(smsReplyWorkTable).where(and(workKey(personId, persona), eq(smsReplyWorkTable.generation, generation), eq(smsReplyWorkTable.heldForStaff, false)));
}
export async function releaseSmsReplyHold(personId: string, persona: SmsPersona) {
  await db.delete(smsReplyWorkTable).where(and(workKey(personId, persona), eq(smsReplyWorkTable.heldForStaff, true)));
}

/** Retain a review hold even when a new inbound arrives during the final answer. */
export async function holdSmsReplyForStaff(personId: string, persona: SmsPersona) {
  await db.insert(smsReplyWorkTable).values({ personId, persona, heldForStaff: true }).onConflictDoUpdate({
    target: [smsReplyWorkTable.personId, smsReplyWorkTable.persona], set: { heldForStaff: true },
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export async function flagSmsDeliveryForStaff(personId: string, tx?: Tx): Promise<void> {
  if (!tx) return db.transaction((transaction) => flagSmsDeliveryForStaff(personId, transaction));
  await tx.select({ id: customersTable.id }).from(customersTable).where(eq(customersTable.id, personId)).for("update");
  const reason = "SMS delivery is unconfirmed or failed. Review the provider conversation, then reply or clear this flag to resume. No automatic resend was attempted.";
  await tx.update(conversationsTable).set({ needsAttention: true, needsAttentionReason: reason }).where(eq(conversationsTable.personId, personId));
  await tx.update(supportConversationsTable).set({ needsAttention: true, needsAttentionReason: reason }).where(eq(supportConversationsTable.personId, personId));
  for (const persona of ["sales", "support"] as const) {
    const conversations = persona === "sales" ? conversationsTable : supportConversationsTable;
    const [existing] = await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.personId, personId));
    if (!existing) continue;
    await tx.insert(smsReplyWorkTable).values({ personId, persona, heldForStaff: true }).onConflictDoUpdate({
      target: [smsReplyWorkTable.personId, smsReplyWorkTable.persona], set: { heldForStaff: true },
    });
  }
}

const flagPerson = flagSmsDeliveryForStaff;

/** A provider-confirmed sent event releases pacing; it does not claim delivery. */
export async function hasPendingSmsDelivery(personId: string): Promise<boolean> {
  const sales = await db.select({ status: conversationMessagesTable.deliveryStatus, createdAt: conversationMessagesTable.createdAt })
    .from(conversationMessagesTable).innerJoin(conversationsTable, eq(conversationsTable.id, conversationMessagesTable.conversationId))
    .where(and(eq(conversationsTable.personId, personId), eq(conversationMessagesTable.deliveryStatus, "queued")));
  const support = await db.select({ status: supportConversationMessagesTable.deliveryStatus, createdAt: supportConversationMessagesTable.createdAt })
    .from(supportConversationMessagesTable).innerJoin(supportConversationsTable, eq(supportConversationsTable.id, supportConversationMessagesTable.conversationId))
    .where(and(eq(supportConversationsTable.personId, personId), eq(supportConversationMessagesTable.deliveryStatus, "queued")));
  const pending = [...sales, ...support];
  if (pending.some((m) => Date.now() - m.createdAt.getTime() >= TIMEOUT_MS)) await flagPerson(personId);
  return pending.length > 0;
}

const rank = { sent: 1, failed: 2, delivered: 3, read: 4 } as const;
/** A transaction and row lock keep duplicate/out-of-order receipts monotonic. */
export async function recordSmsDeliveryReceipt(providerMessageId: string, status: keyof typeof rank, occurredAt: Date) {
  let matched = false;
  await db.transaction(async (tx) => {
    await tx.insert(smsDeliveryReceiptsTable).values({ providerMessageId, status }).onConflictDoNothing();
    const [old] = await tx.select().from(smsDeliveryReceiptsTable)
      .where(eq(smsDeliveryReceiptsTable.providerMessageId, providerMessageId)).for("update");
    const patch = {
      status: rank[status] > rank[old.status] ? status : old.status,
      sentAt: status === "sent" && (!old.sentAt || occurredAt < old.sentAt) ? occurredAt : old.sentAt,
      deliveredAt: status === "delivered" && (!old.deliveredAt || occurredAt < old.deliveredAt) ? occurredAt : old.deliveredAt,
      readAt: status === "read" && (!old.readAt || occurredAt < old.readAt) ? occurredAt : old.readAt,
    };
    await tx.update(smsDeliveryReceiptsTable).set(patch).where(eq(smsDeliveryReceiptsTable.providerMessageId, providerMessageId));
    for (const table of [conversationMessagesTable, supportConversationMessagesTable, unmatchedSmsMessagesTable]) {
      const rows = await tx.update(table).set({ deliveryStatus: patch.status, sentAt: patch.sentAt, deliveredAt: patch.deliveredAt, readAt: patch.readAt })
        .where(and(eq(table.providerMessageId, providerMessageId), eq(table.direction, "outbound"))).returning({ id: table.id });
      matched ||= rows.length > 0;
    }
  });
  const [receipt] = await db.select().from(smsDeliveryReceiptsTable).where(eq(smsDeliveryReceiptsTable.providerMessageId, providerMessageId));
  if (receipt?.status === "failed") {
    for (const [table, conversations] of [[conversationMessagesTable, conversationsTable], [supportConversationMessagesTable, supportConversationsTable]] as const) {
      const matches = await db.select({ personId: conversations.personId }).from(table)
        .innerJoin(conversations, eq(conversations.id, table.conversationId)).where(eq(table.providerMessageId, providerMessageId));
      for (const match of matches) await flagPerson(match.personId);
    }
  }
  return matched && receipt?.status === status;
}

export async function reconcileSmsDelivery(providerMessageId: string | null | undefined) {
  if (!providerMessageId) return;
  const [receipt] = await db.select().from(smsDeliveryReceiptsTable).where(eq(smsDeliveryReceiptsTable.providerMessageId, providerMessageId));
  if (receipt) {
    // Reuse the locked path so a late reconciliation cannot overwrite a newer receipt.
    await recordSmsDeliveryReceipt(providerMessageId, receipt.status, receipt.status === "read" ? receipt.readAt! : receipt.status === "delivered" ? receipt.deliveredAt! : receipt.status === "sent" ? receipt.sentAt! : new Date());
  }
}

/** Reserve the outgoing row before transport. Unknown outcomes are never auto-retried. */
export async function sendTrackedSms(personId: string, persona: SmsPersona, conversationId: string, phone: string | null, body: string, generation: string, holdForStaff = false) {
  const table = messageTable(persona);
  const message = await db.transaction(async (tx) => {
    const [claimed] = await tx.delete(smsReplyWorkTable).where(and(workKey(personId, persona), eq(smsReplyWorkTable.generation, generation), eq(smsReplyWorkTable.heldForStaff, false))).returning();
    if (!claimed) return null;
    const [row] = await tx.insert(table).values({ conversationId, direction: "outbound", body, sentBy: "ai", deliveryStatus: phone ? "queued" : "failed" }).returning();
    if (holdForStaff) await tx.insert(smsReplyWorkTable).values({ personId, persona, heldForStaff: true }).onConflictDoUpdate({
      target: [smsReplyWorkTable.personId, smsReplyWorkTable.persona], set: { heldForStaff: true },
    });
    return row;
  });
  if (!message) return;
  if (!phone) { await flagPerson(personId); return; }
  await sendReservedSms(personId, persona, message.id, phone, body);
}

/** Transport for an already durable outbound reservation; callers must not retry it. */
export async function sendReservedSms(personId: string, persona: SmsPersona, messageId: string, phone: string, body: string, options?: { scheduled?: boolean }) {
  const table = messageTable(persona);
  try {
    await assertPhoneSmsAllowed(phone);
    if (persona === "sales" && options?.scheduled && isSalesSmsPaused()) throw new SalesSmsPausedError();
    if (options?.scheduled) assertScheduledSmsTime();
    const provider = getSmsProvider();
    const result = options?.scheduled ? await provider.sendMessage(phone, body, options) : await provider.sendMessage(phone, body);
    await db.update(table).set({ providerMessageId: result.providerMessageId }).where(eq(table.id, messageId));
    await reconcileSmsDelivery(result.providerMessageId);
  } catch (err) {
    if (err instanceof SmsQuietHoursError || err instanceof SalesSmsPausedError) throw err; // No transport attempted; caller can safely defer its reservation.
    if (err instanceof SmsOptOutError) {
      await db.update(table).set({ deliveryStatus: "failed" }).where(and(eq(table.id, messageId), eq(table.deliveryStatus, "queued")));
      return;
    }
    // A timeout/disconnect may happen after acceptance; do not claim definite non-delivery.
    await db.transaction(async (tx) => {
      // Persist the hold with the uncertain outcome, including across a restart.
      await flagSmsDeliveryForStaff(personId, tx);
      await tx.update(table).set({ deliveryStatus: "unknown" }).where(and(eq(table.id, messageId), eq(table.deliveryStatus, "queued")));
    });
  }
}

export async function sweepSmsDeliveryTimeouts() {
  const before = new Date(Date.now() - TIMEOUT_MS);
  for (const [table, conversations] of [
    [conversationMessagesTable, conversationsTable],
    [supportConversationMessagesTable, supportConversationsTable],
  ] as const) {
    const expired = await db.select({ personId: conversations.personId, id: table.id }).from(table)
      .innerJoin(conversations, eq(conversations.id, table.conversationId))
      .where(and(eq(table.deliveryStatus, "queued"), lt(table.createdAt, before))).limit(100);
    for (const row of expired) {
      const [expired] = await db.update(table).set({ deliveryStatus: "unknown" })
        .where(and(eq(table.id, row.id), eq(table.deliveryStatus, "queued"))).returning({ id: table.id });
      if (expired) await flagPerson(row.personId);
    }
  }
}
