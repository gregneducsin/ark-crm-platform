import { and, desc, eq, lt, lte, or, sql } from "drizzle-orm";
import {
  db, customersTable, conversationsTable, conversationMessagesTable, supportConversationsTable,
  supportConversationMessagesTable, emailConversationsTable, supportEmailConversationsTable, smsReplyWorkTable,
  followUpJobsTable, intakeLinkTokensTable, questionnaireEventsTable, purchasesTable,
  abandonedCartTriggersTable, leadCheckinTriggersTable, objectionReengagementTriggersTable,
} from "@luma/db";
import { withPersonLock } from "../lib/db-lock.js";
import { clampToSendWindow, isScheduledSmsTime, SmsQuietHoursError } from "../lib/send-window.js";
import {
  renderFollowUpMessage, renderCurrentlyTakingCheckin, renderReengagementCheckin,
  renderAbandonedCartOpener, renderAbandonedCartFollowUp,
} from "../lib/messaging/follow-up-templates.js";
import { sendReservedSms, flagSmsDeliveryForStaff } from "./sms-delivery.service.js";
import { isSalesSmsPaused, SalesSmsPausedError } from "../lib/sales-sms.js";
import { logger } from "../lib/logger.js";

const tables = {
  follow_up: followUpJobsTable, abandoned_cart: abandonedCartTriggersTable,
  lead_checkin: leadCheckinTriggersTable,
  objection_reengagement: objectionReengagementTriggersTable,
};
export type ScheduledSalesSmsKind = keyof typeof tables;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Customer = typeof customersTable.$inferSelect;
type Outcome = "sent" | "cancelled" | "failed" | "deferred";
export interface ScheduledSalesSmsSweepResult { sentCount: number; cancelledCount: number; failedCount: number }
const DELIVERY_TIMEOUT_MS = 5 * 60 * 1000;
const CHECKIN_DELAY_MS = 6 * 24 * 60 * 60 * 1000;
const retryTables = { lead_checkin: leadCheckinTriggersTable, objection_reengagement: objectionReengagementTriggersTable };
type Plan = { cancel: string } | {
  body: string; leadSource?: "abandoned_cart" | "meta_form"; promoOffered?: boolean;
  variant?: "currently_taking" | "reengagement"; armCheckin?: boolean;
};

async function armCheckin(tx: Tx, personId: string) {
  await tx.insert(leadCheckinTriggersTable).values({ personId, dueAt: new Date(Date.now() + CHECKIN_DELAY_MS) })
    .onConflictDoNothing({ target: leadCheckinTriggersTable.personId });
}

/** Business eligibility and templates are evaluated from current rows, under
 * the send reservation transaction, never from the sweep's stale snapshot. */
async function prepare(tx: Tx, kind: ScheduledSalesSmsKind, id: string, customer: Customer): Promise<Plan> {
  const personId = customer.id;
  if (customer.dnd) return { cancel: "opted_out" };
  if (kind === "follow_up") {
    const [job] = await tx.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, id));
    const [token] = await tx.select().from(intakeLinkTokensTable).where(eq(intakeLinkTokensTable.id, job.intakeLinkTokenId));
    if (!token) return { cancel: "intake_link_removed" };
    if (token.clickedAt) {
      const [submitted] = await tx.select({ id: questionnaireEventsTable.id }).from(questionnaireEventsTable)
        .where(and(eq(questionnaireEventsTable.personId, personId), eq(questionnaireEventsTable.status, "submitted"), sql`${questionnaireEventsTable.lastEventAt} >= ${token.clickedAt}`)).limit(1);
      const [purchased] = await tx.select({ id: purchasesTable.id }).from(purchasesTable)
        .where(and(eq(purchasesTable.customerId, personId), eq(purchasesTable.status, "completed"), sql`${purchasesTable.createdAt} >= ${token.clickedAt}`)).limit(1);
      if (submitted || purchased) return { cancel: "completed_before_followup" };
    }
    return { body: renderFollowUpMessage(job.messageStep, customer.firstName), leadSource: token.leadSource };
  }
  const [purchase] = await tx.select({ id: purchasesTable.id }).from(purchasesTable)
    .where(and(eq(purchasesTable.customerId, personId), eq(purchasesTable.status, "completed"))).limit(1);
  if (purchase) return { cancel: "already_purchased" };
  const [conversation] = await tx.select().from(conversationsTable).where(eq(conversationsTable.personId, personId));
  if (kind === "abandoned_cart") {
    const [trigger] = await tx.select().from(abandonedCartTriggersTable).where(eq(abandonedCartTriggersTable.id, id));
    const [event] = await tx.select().from(questionnaireEventsTable).where(eq(questionnaireEventsTable.id, trigger.questionnaireEventId));
    if (!event || event.status !== "abandoned") return { cancel: "no_longer_abandoned" };
    const [token] = await tx.select().from(intakeLinkTokensTable).where(eq(intakeLinkTokensTable.personId, personId)).orderBy(desc(intakeLinkTokensTable.createdAt)).limit(1);
    if (token?.clickedAt) { await armCheckin(tx, personId); return { cancel: "already_clicked_intake_link" }; }
    return { body: conversation ? renderAbandonedCartFollowUp(customer.firstName) : renderAbandonedCartOpener(customer.firstName), promoOffered: true, armCheckin: true };
  }
  if (kind === "lead_checkin") {
    const variant = !conversation || conversation.currentlyTaking === null ? "currently_taking" : "reengagement";
    return { variant, body: variant === "currently_taking" ? renderCurrentlyTakingCheckin(customer.firstName) : renderReengagementCheckin(customer.firstName) };
  }
  const [trigger] = await tx.select().from(objectionReengagementTriggersTable).where(eq(objectionReengagementTriggersTable.id, id));
  return { body: renderReengagementCheckin(customer.firstName), leadSource: trigger.leadSource };
}

async function isHeldOrBusy(tx: Tx, personId: string): Promise<boolean> {
  // Read flags with row locks so a concurrently committed staff hold is not
  // missed. Lock order is consistent across scheduled send kinds.
  for (const table of [conversationsTable, supportConversationsTable, emailConversationsTable, supportEmailConversationsTable]) {
    const [conversation] = await tx.select({ needsAttention: table.needsAttention }).from(table)
      .where(eq(table.personId, personId)).for("update");
    if (conversation?.needsAttention) return true;
  }
  // Any pending inbound turn takes priority over a proactive nudge, including STOP.
  const [work] = await tx.select({ personId: smsReplyWorkTable.personId }).from(smsReplyWorkTable).where(eq(smsReplyWorkTable.personId, personId)).limit(1);
  if (work) return true;
  for (const [messages, conversations] of [[conversationMessagesTable, conversationsTable], [supportConversationMessagesTable, supportConversationsTable]] as const) {
    const [pending] = await tx.select({ id: messages.id }).from(messages).innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(and(eq(conversations.personId, personId), eq(messages.direction, "outbound"), eq(messages.deliveryStatus, "queued"))).limit(1);
    if (pending) return true;
  }
  return false;
}

async function finishConfirmed(tx: Tx, kind: ScheduledSalesSmsKind, id: string, customer: Customer, sentAt: Date, providerMessageId: string | null) {
  const table = tables[kind];
  const [updated] = await tx.update(table).set({ status: "sent", sentAt, providerMessageId, failureReason: null })
    .where(and(eq(table.id, id), eq(table.status, "processing"))).returning({ id: table.id });
  if (!updated || kind !== "follow_up") return;
  const plan = await prepare(tx, kind, id, customer);
  if ("cancel" in plan) return; // Do not arm another step after STOP/completion.
  const [job] = await tx.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, id));
  const next = job.messageStep === "provider_check_in" ? "intake_questions_check_in" : null;
  if (!next) return;
  const delay = 60 * 60 * 1000;
  await tx.insert(followUpJobsTable).values({ personId: customer.id, intakeLinkTokenId: job.intakeLinkTokenId,
    messageStep: next, dueAt: clampToSendWindow(new Date(sentAt.getTime() + delay)) }).onConflictDoNothing();
}

/** The job UUID is also its outbound UUID. An accepted or uncertain attempt
 * can therefore be recovered without guessing whether it should be resent. */
async function processJob(kind: ScheduledSalesSmsKind, id: string, personId: string): Promise<Outcome> {
  const table = tables[kind];
  return withPersonLock(personId, async () => {
    if (isSalesSmsPaused()) return "deferred";
    const result = await db.transaction(async (tx) => {
      const [customer] = await tx.select().from(customersTable).where(eq(customersTable.id, personId)).for("update");
      const [job] = await tx.select().from(table).where(eq(table.id, id)).for("update");
      if (!customer || !job || job.status === "cancelled" || job.status === "sent") return { outcome: "deferred" as const };
      const [attempt] = await tx.select().from(conversationMessagesTable).where(eq(conversationMessagesTable.id, id)).for("update");
      if (job.status === "processing" || attempt) {
        if (attempt && ["sent", "delivered", "read"].includes(attempt.deliveryStatus ?? "")) {
          await finishConfirmed(tx, kind, id, customer, attempt.sentAt ?? attempt.deliveredAt ?? attempt.readAt ?? attempt.createdAt, attempt.providerMessageId);
          return { outcome: "sent" as const };
        }
        if (attempt?.deliveryStatus === "queued" && Date.now() - attempt.createdAt.getTime() < DELIVERY_TIMEOUT_MS) {
          await tx.update(table).set({ updatedAt: new Date() }).where(eq(table.id, id));
          return { outcome: "deferred" as const };
        }
        // Includes legacy processing jobs with no durable attempt: do not
        // assume their previous process failed before provider acceptance.
        if (!attempt) {
          const plan = await prepare(tx, kind, id, customer);
          // An old claim may predate conversation creation. Give staff a
          // visible review thread even in that case.
          await tx.insert(conversationsTable).values({ personId, leadSource: "cancel" in plan ? "abandoned_cart" : plan.leadSource ?? "abandoned_cart" }).onConflictDoNothing();
        }
        if (attempt?.deliveryStatus === "queued") await tx.update(conversationMessagesTable).set({ deliveryStatus: "unknown" })
          .where(and(eq(conversationMessagesTable.id, id), eq(conversationMessagesTable.deliveryStatus, "queued")));
        await tx.update(table).set({ status: "failed", failureReason: "SMS_DELIVERY_UNCONFIRMED_REVIEW_REQUIRED" }).where(eq(table.id, id));
        await flagSmsDeliveryForStaff(personId, tx);
        return { outcome: "failed" as const };
      }
      if (job.dueAt > new Date()) return { outcome: "deferred" as const };
      if (job.status === "failed" && (job.failureReason !== "NO_PHONE_NUMBER" || job.updatedAt > new Date(Date.now() - 30 * 60 * 1000))) return { outcome: "deferred" as const };
      const heldOrBusy = await isHeldOrBusy(tx, personId);
      const plan = await prepare(tx, kind, id, customer);
      if ("cancel" in plan) {
        await tx.update(table).set({ status: "cancelled", cancelledReason: plan.cancel }).where(eq(table.id, id));
        return { outcome: "cancelled" as const };
      }
      if (!isScheduledSmsTime()) {
        await tx.update(table).set({ dueAt: clampToSendWindow(new Date()), updatedAt: new Date() }).where(eq(table.id, id));
        return { outcome: "deferred" as const };
      }
      if (heldOrBusy) {
        // Leave dueAt and the template untouched; rotate the scan position
        // so held conversations cannot starve other customers in the batch.
        await tx.update(table).set({ updatedAt: new Date() }).where(eq(table.id, id));
        return { outcome: "deferred" as const };
      }
      const retryTable = kind in retryTables ? retryTables[kind as keyof typeof retryTables] : null;
      if (retryTable) {
        const [retry] = await tx.select({ count: retryTable.attemptCount }).from(retryTable).where(eq(retryTable.id, id));
        if (retry.count >= 3) return { outcome: "deferred" as const };
        await tx.update(retryTable).set({ attemptCount: sql`${retryTable.attemptCount} + 1` }).where(eq(retryTable.id, id));
      }
      if (kind === "abandoned_cart" && plan.armCheckin) await armCheckin(tx, personId);
      if (!customer.phone) {
        await tx.update(table).set({ status: "failed", failureReason: "NO_PHONE_NUMBER" }).where(eq(table.id, id));
        return { outcome: "failed" as const };
      }
      await tx.insert(conversationsTable).values({ personId, leadSource: plan.leadSource ?? "abandoned_cart" }).onConflictDoNothing();
      const [conversation] = await tx.select().from(conversationsTable).where(eq(conversationsTable.personId, personId));
      if (plan.promoOffered) await tx.update(conversationsTable).set({ promoOffered: true }).where(eq(conversationsTable.id, conversation.id));
      if (plan.variant) await tx.update(leadCheckinTriggersTable).set({ variant: plan.variant }).where(eq(leadCheckinTriggersTable.id, id));
      if (plan.armCheckin) await armCheckin(tx, personId);
      await tx.update(table).set({ status: "processing", failureReason: null }).where(eq(table.id, id));
      await tx.insert(conversationMessagesTable).values({ id, conversationId: conversation.id, direction: "outbound", body: plan.body, sentBy: "ai", deliveryStatus: "queued" });
      return { outcome: "deferred" as const, send: { phone: customer.phone, body: plan.body } };
    });
    if (!result.send) return result.outcome;
    try {
      await sendReservedSms(personId, "sales", id, result.send.phone, result.send.body, { scheduled: true });
    } catch (err) {
      if (!(err instanceof SmsQuietHoursError) && !(err instanceof SalesSmsPausedError)) throw err;
      // Closing time may pass while waiting for locks/transport preparation.
      // This specific error guarantees no provider submission occurred.
      await db.transaction(async (tx) => {
        await tx.delete(conversationMessagesTable).where(and(eq(conversationMessagesTable.id, id), eq(conversationMessagesTable.deliveryStatus, "queued"), sql`${conversationMessagesTable.providerMessageId} is null`));
        await tx.update(table).set({ status: "pending", dueAt: clampToSendWindow(new Date()), failureReason: null })
          .where(and(eq(table.id, id), eq(table.status, "processing")));
        if (kind in retryTables) {
          const retry = retryTables[kind as keyof typeof retryTables];
          await tx.update(retry).set({ attemptCount: sql`greatest(${retry.attemptCount} - 1, 0)` }).where(eq(retry.id, id));
        }
      });
      return "deferred";
    }
    // A receipt may already have arrived before sendMessage returned.
    return db.transaction(async (tx): Promise<Outcome> => {
      const [customer] = await tx.select().from(customersTable).where(eq(customersTable.id, personId)).for("update");
      const [job] = await tx.select().from(table).where(eq(table.id, id)).for("update");
      if (!customer || job?.status !== "processing") return "deferred";
      const [attempt] = await tx.select().from(conversationMessagesTable).where(eq(conversationMessagesTable.id, id));
      if (["sent", "delivered", "read"].includes(attempt.deliveryStatus ?? "")) {
        await finishConfirmed(tx, kind, id, customer, attempt.sentAt ?? attempt.deliveredAt ?? attempt.readAt ?? attempt.createdAt, attempt.providerMessageId);
        return "sent";
      }
      if (attempt.deliveryStatus === "unknown" || attempt.deliveryStatus === "failed") {
        await tx.update(table).set({ status: "failed", failureReason: "SMS_DELIVERY_UNCONFIRMED_REVIEW_REQUIRED" }).where(eq(table.id, id));
        return "failed";
      }
      await tx.update(table).set({ providerMessageId: attempt.providerMessageId }).where(eq(table.id, id));
      return "deferred";
    });
  });
}

export async function sweepScheduledSalesSms(kind: ScheduledSalesSmsKind): Promise<ScheduledSalesSmsSweepResult> {
  if (isSalesSmsPaused()) return { sentCount: 0, cancelledCount: 0, failedCount: 0 };
  const table = tables[kind];
  const retryTable = kind in retryTables ? retryTables[kind as keyof typeof retryTables] : null;
  // Select, do not claim an entire backlog before acquiring person locks.
  // Recheck each candidate in processJob; overlapping sweeps are harmless.
  const pending = await db.select({ id: table.id, personId: table.personId }).from(table).where(or(
    and(eq(table.status, "pending"), lte(table.dueAt, sql`now()`)), eq(table.status, "processing"),
    retryTable ? and(eq(table.status, "failed"), eq(table.failureReason, "NO_PHONE_NUMBER"), lte(table.dueAt, sql`now()`), lt(retryTable.attemptCount, 3), lte(table.updatedAt, new Date(Date.now() - 30 * 60 * 1000))) : undefined,
  )).orderBy(table.updatedAt).limit(100);
  const counts = { sentCount: 0, cancelledCount: 0, failedCount: 0 };
  for (const job of pending) {
    try {
      const outcome = await processJob(kind, job.id, job.personId);
      if (outcome === "sent") counts.sentCount++;
      if (outcome === "cancelled") counts.cancelledCount++;
      if (outcome === "failed") counts.failedCount++;
    } catch {
      logger.error({ kind, jobId: job.id }, "Scheduled SMS retained for recovery; no blind resend");
    }
  }
  if (counts.sentCount || counts.cancelledCount || counts.failedCount) {
    logger.info({ kind, ...counts }, "Scheduled sales SMS sweep completed");
  }
  return counts;
}
