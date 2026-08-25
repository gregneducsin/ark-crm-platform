import { pgTable, text, uuid, timestamp, boolean, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { customersTable } from "./customers";

/**
 * One "Sophie" post-purchase support conversation thread per customer (1:1).
 * Separate from the Alexis `conversations` table entirely — different persona,
 * different tab, different purpose (order/prescription/shipping support for
 * existing customers, not sales outreach to prospects). Fired the moment a
 * Bask order-purchased webhook lands; updated as prescription-written and
 * order-shipped events arrive.
 */
export const supportConversationsTable = pgTable(
  "support_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    prescriptionWritten: boolean("prescription_written").notNull().default(false),
    prescriptionWrittenAt: timestamp("prescription_written_at", { withTimezone: true }),
    orderShipped: boolean("order_shipped").notNull().default(false),
    orderShippedAt: timestamp("order_shipped_at", { withTimezone: true }),
    trackingNumber: text("tracking_number"),
    /** Set when a bask_payment_failed webhook arrives for this customer's order — see handlePaymentFailed. Never auto-cleared; a person clears it (or a future successful order overwrites the picture) once it's resolved. */
    paymentFailed: boolean("payment_failed").notNull().default(false),
    paymentFailedAt: timestamp("payment_failed_at", { withTimezone: true }),
    /** Set once the post-delivery "how was your experience" check-in has been sent — never re-asked. */
    reviewRequested: boolean("review_requested").notNull().default(false),
    reviewSentiment: text("review_sentiment", { enum: ["positive", "neutral", "negative"] }),
    lastQuestion: text("last_question"),
    pendingTopic: text("pending_topic"),
    lastDraft: text("last_draft"),
    /**
     * True whenever the most recent turn required staff attention — a
     * pre-check block (STOP/emergency/prescription/legal), a model-flagged
     * staff_review, or a turn the guardrail rejected outright. Cleared by a
     * staff member reviewing the conversation, not automatically. Same
     * pattern as conversations.needsAttention.
     */
    needsAttention: boolean("needs_attention").notNull().default(false),
    /** Human-readable explanation of why needsAttention is set — see needs-attention-reason.ts. Null whenever needsAttention is false. */
    needsAttentionReason: text("needs_attention_reason"),
    status: text("status", { enum: ["active", "closed"] }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("support_conversations_person_id_key").on(t.personId), index("support_conversations_status_idx").on(t.status)],
);

/**
 * Every message in a support conversation, in order. `sentiment` is set on
 * inbound messages only, tagged by the same Claude call that produces
 * Sophie's reply (no separate classification call) — same pattern as
 * conversation_messages.
 */
export const supportConversationMessagesTable = pgTable(
  "support_conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => supportConversationsTable.id, { onDelete: "cascade" }),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    body: text("body").notNull(),
    sentiment: text("sentiment", { enum: ["positive", "neutral", "negative"] }),
    providerMessageId: text("provider_message_id"),
    /** Who actually wrote an outbound message — Sophie (or an automated trigger) vs a staff member typing into the reply box. Null on inbound (always the customer). */
    sentBy: text("sent_by", { enum: ["ai", "staff"] }),
    /** Which staff member actually sent it — set only when sentBy is "staff". Denormalized (not an FK), same convention as customer_notes.authorEmail, so history reads correctly even if the account is later renamed/disabled. */
    sentByStaffEmail: text("sent_by_staff_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("support_conversation_messages_conversation_id_idx").on(t.conversationId, t.createdAt)],
);

/**
 * Schedules the post-delivery "how was your experience" check-in, armed when
 * the order-shipped webhook fires. One row per customer ever (unique index)
 * — a customer with multiple orders only gets asked once, not once per
 * shipment. Fully automated sweep, same pattern as abandoned_cart_triggers.
 */
export const reviewRequestTriggersTable = pgTable(
  "review_request_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    // "processing" is a transient claim state — see the identical comment on
    // followUpJobsTable.status in schema/messaging.ts.
    status: text("status", { enum: ["pending", "processing", "sent", "cancelled", "failed"] }).notNull().default("pending"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    cancelledReason: text("cancelled_reason"),
    failureReason: text("failure_reason"),
    // A failed send used to be permanently lost — the sweep only ever looked
    // at status="pending", so a transient SMS-provider error on attempt 1
    // meant that customer never got a review request again. attemptCount lets
    // the sweep retry a failed trigger a bounded number of times instead.
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("review_request_triggers_person_id_key").on(t.personId),
    index("review_request_triggers_status_due_at_idx").on(t.status, t.dueAt),
  ],
);

export type SupportConversation = typeof supportConversationsTable.$inferSelect;
export type SupportConversationMessage = typeof supportConversationMessagesTable.$inferSelect;
export type ReviewRequestTrigger = typeof reviewRequestTriggersTable.$inferSelect;
