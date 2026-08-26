import { pgTable, text, uuid, timestamp, boolean, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { customersTable } from "./customers";
import { questionnaireEventsTable } from "./webhooks";

/**
 * Email twin of conversationsTable (messaging.ts) — one Alexis email thread per
 * customer (1:1), same slot/state shape, same guardrail pipeline
 * (runAlexisTurn is channel-agnostic and is reused unchanged for email turns).
 * Kept as its own table rather than adding a "channel" column to
 * conversationsTable: lower risk, ships without touching the SMS schema or
 * any of the routes/tests that assume one SMS conversation per person today.
 */
export const emailConversationsTable = pgTable(
  "email_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    leadSource: text("lead_source", { enum: ["abandoned_cart", "meta_form"] }).notNull().default("abandoned_cart"),
    state: text("state"),
    selectedProduct: text("selected_product", { enum: ["semaglutide", "tirzepatide"] }),
    currentlyTaking: text("currently_taking", { enum: ["yes", "no"] }),
    wantsProcessExplanation: text("wants_process_explanation", { enum: ["yes", "no"] }),
    hasTimeForIntake: text("has_time_for_intake", { enum: ["yes", "no"] }),
    wantsPlanInclusions: text("wants_plan_inclusions", { enum: ["yes", "no"] }),
    readyForForm: text("ready_for_form", { enum: ["yes", "no"] }),
    lastQuestion: text("last_question"),
    pendingTopic: text("pending_topic"),
    lastDraft: text("last_draft"),
    objectionStage: integer("objection_stage").notNull().default(0),
    /** Which objection objectionStage belongs to — see the identical field on conversationsTable in messaging.ts. */
    objectionKey: text("objection_key", {
      enum: ["price", "think_about_it", "not_qualified", "is_legit", "no_time", "found_cheaper", "side_effects"],
    }),
    linkProvided: boolean("link_provided").notNull().default(false),
    promoOffered: boolean("promo_offered").notNull().default(false),
    needsAttention: boolean("needs_attention").notNull().default(false),
    /** Human-readable explanation of why needsAttention is set — see needs-attention-reason.ts. Null whenever needsAttention is false. */
    needsAttentionReason: text("needs_attention_reason"),
    /**
     * Which real mailbox (e.g. help@ vs support@) this customer's most
     * recent inbound email arrived at, when more than one is polled (see
     * EMAIL_INBOUND_EXTRA_MAILBOXES) — Alexis's replies send from this exact
     * address instead of always one fixed mailbox, so a customer who wrote
     * to help@ keeps hearing back from help@, not a different address than
     * the one they actually used. Null until their first inbound email; a
     * conversation that only ever received outbound trigger emails
     * (abandoned-cart opener, etc.) falls back to the provider's default
     * address until a real inbound reply sets this.
     */
    receivingAddress: text("receiving_address"),
    status: text("status", { enum: ["active", "closed"] }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("email_conversations_person_id_key").on(t.personId), index("email_conversations_status_idx").on(t.status)],
);

/**
 * Every message in an email conversation, in order. `messageId`/`inReplyTo`
 * are RFC 5322 Message-ID header values (not a provider-assigned send id
 * like SMS's providerMessageId) — captured on both directions so replies
 * thread correctly in the customer's mail client and so IMAP-polled inbound
 * mail can be deduped/matched by header rather than by content.
 */
export const emailConversationMessagesTable = pgTable(
  "email_conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => emailConversationsTable.id, { onDelete: "cascade" }),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    sentiment: text("sentiment", { enum: ["positive", "neutral", "negative"] }),
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    /** Who actually wrote an outbound message — Alexis (or an automated trigger) vs a staff member typing into the reply box. Null on inbound (always the customer). */
    sentBy: text("sent_by", { enum: ["ai", "staff"] }),
    /** Which staff member actually sent it — set only when sentBy is "staff". Denormalized (not an FK), same convention as customer_notes.authorEmail, so history reads correctly even if the account is later renamed/disabled. */
    sentByStaffEmail: text("sent_by_staff_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("email_conversation_messages_conversation_id_idx").on(t.conversationId, t.createdAt)],
);

/** Email twin of supportConversationsTable (support.ts) — one Sophie email thread per customer (1:1). */
export const supportEmailConversationsTable = pgTable(
  "support_email_conversations",
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
    /** Email twin of supportConversationsTable.paymentFailed — see its docstring. */
    paymentFailed: boolean("payment_failed").notNull().default(false),
    paymentFailedAt: timestamp("payment_failed_at", { withTimezone: true }),
    reviewRequested: boolean("review_requested").notNull().default(false),
    reviewSentiment: text("review_sentiment", { enum: ["positive", "neutral", "negative"] }),
    lastQuestion: text("last_question"),
    pendingTopic: text("pending_topic"),
    lastDraft: text("last_draft"),
    needsAttention: boolean("needs_attention").notNull().default(false),
    /** Human-readable explanation of why needsAttention is set — see needs-attention-reason.ts. Null whenever needsAttention is false. */
    needsAttentionReason: text("needs_attention_reason"),
    /** Sophie's twin of emailConversationsTable.receivingAddress — see its docstring. */
    receivingAddress: text("receiving_address"),
    status: text("status", { enum: ["active", "closed"] }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("support_email_conversations_person_id_key").on(t.personId), index("support_email_conversations_status_idx").on(t.status)],
);

/** Email twin of supportConversationMessagesTable (support.ts). */
export const supportEmailConversationMessagesTable = pgTable(
  "support_email_conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => supportEmailConversationsTable.id, { onDelete: "cascade" }),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    sentiment: text("sentiment", { enum: ["positive", "neutral", "negative"] }),
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    /** Who actually wrote an outbound message — Sophie (or an automated trigger) vs a staff member typing into the reply box. Null on inbound (always the customer). */
    sentBy: text("sent_by", { enum: ["ai", "staff"] }),
    /** Which staff member actually sent it — set only when sentBy is "staff". Denormalized (not an FK), same convention as customer_notes.authorEmail, so history reads correctly even if the account is later renamed/disabled. */
    sentByStaffEmail: text("sent_by_staff_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("support_email_conversation_messages_conversation_id_idx").on(t.conversationId, t.createdAt)],
);

/**
 * The 4-step abandoned-cart email nurture sequence — a distinct schedule
 * from the SMS abandoned-cart opener (abandonedCartTriggersTable), all
 * timed off the same abandonment event but on its own cadence: opener
 * (10 min), urgency (24 hr), educational (7 days), plan_comparison
 * (10 days). One row per step per abandonment event (unique on
 * questionnaireEventId+step), so a duplicate `abandoned` webhook delivery
 * can't double-schedule any step, and each step is independently
 * claimable/cancellable — a later step can still be cancelled (e.g. the
 * lead purchased) even after an earlier step already sent.
 */
export const abandonedCartEmailTriggersTable = pgTable(
  "abandoned_cart_email_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    questionnaireEventId: uuid("questionnaire_event_id")
      .notNull()
      .references(() => questionnaireEventsTable.id, { onDelete: "cascade" }),
    step: text("step", { enum: ["opener", "urgency", "educational", "plan_comparison"] }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    // "processing" is a transient claim state — see the identical comment on
    // followUpJobsTable.status (messaging.ts).
    status: text("status", { enum: ["pending", "processing", "sent", "cancelled", "failed"] }).notNull().default("pending"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    messageId: text("message_id"),
    cancelledReason: text("cancelled_reason"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("abandoned_cart_email_triggers_event_step_key").on(t.questionnaireEventId, t.step),
    index("abandoned_cart_email_triggers_status_due_at_idx").on(t.status, t.dueAt),
    index("abandoned_cart_email_triggers_person_id_idx").on(t.personId),
  ],
);

/**
 * The same 4-step nurture sequence as abandonedCartEmailTriggersTable
 * (identical templates and cadence — opener 10 min, urgency 24 hr,
 * educational 7 days, plan_comparison 10 days), armed instead off a Meta
 * lead-gen form-fill. Its own table rather than reusing
 * abandonedCartEmailTriggersTable because there's no questionnaire event to
 * key off for a Meta lead — the unique constraint here is on personId+step
 * directly, since a Meta lead-gen submission has no repeatable "event" the
 * way a questionnaire (started/abandoned/submitted) does.
 */
export const metaLeadEmailTriggersTable = pgTable(
  "meta_lead_email_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    step: text("step", { enum: ["opener", "urgency", "educational", "plan_comparison"] }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    // "processing" is a transient claim state — see the identical comment on
    // followUpJobsTable.status (messaging.ts).
    status: text("status", { enum: ["pending", "processing", "sent", "cancelled", "failed"] }).notNull().default("pending"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    messageId: text("message_id"),
    cancelledReason: text("cancelled_reason"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("meta_lead_email_triggers_person_step_key").on(t.personId, t.step),
    index("meta_lead_email_triggers_status_due_at_idx").on(t.status, t.dueAt),
  ],
);

/**
 * One row per unrecognized SENDER (not per email) — a second email from the
 * same address joins the same thread via unmatchedEmailMessagesTable rather
 * than creating a disconnected duplicate. linkedCustomerId is set once this
 * sender has been turned into a real lead (see recordAndClassifyUnmatchedEmail
 * in unmatched-inbound-email.service.ts) — distinct from
 * suggestedMatchCustomerId, which is an unconfirmed guess that this sender
 * might be a DIFFERENT, already-existing customer using a new address.
 */
export const unmatchedEmailThreadsTable = pgTable(
  "unmatched_email_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromAddress: text("from_address").notNull(),
    fromName: text("from_name"),
    /**
     * A phone number gathered mid-thread specifically so a lead can be
     * created — customers.phone is nullable, so unlike email (already known
     * here, it's who's writing in) this isn't automatic. Mirrors
     * collectedEmail on unmatchedSmsThreadsTable (messaging.ts): both
     * pipelines require gathering the OTHER contact channel before creating
     * a customer row, so support staff always has more than one way to
     * reach a brand-new lead.
     */
    collectedPhone: text("collected_phone"),
    aiIntent: text("ai_intent"),
    aiSummary: text("ai_summary"),
    suggestedMatchCustomerId: uuid("suggested_match_customer_id").references(() => customersTable.id, { onDelete: "set null" }),
    suggestedMatchConfidence: text("suggested_match_confidence", { enum: ["high", "medium", "low"] }),
    suggestedReply: text("suggested_reply"),
    linkedCustomerId: uuid("linked_customer_id").references(() => customersTable.id, { onDelete: "set null" }),
    /** Same idea as emailConversationsTable.receivingAddress — which real mailbox this unrecognized sender's most recent email arrived at, so any reply goes back out from that same address. */
    receivingAddress: text("receiving_address"),
    status: text("status", { enum: ["needs_review", "replied", "dismissed"] }).notNull().default("needs_review"),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("unmatched_email_threads_from_address_key").on(t.fromAddress)],
);

/** Every message in an unmatched-sender thread, in order — inbound (their emails) and outbound (staff-approved replies). */
export const unmatchedEmailMessagesTable = pgTable(
  "unmatched_email_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => unmatchedEmailThreadsTable.id, { onDelete: "cascade" }),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    messageId: text("message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("unmatched_email_messages_thread_id_idx").on(t.threadId, t.createdAt)],
);

export type EmailConversation = typeof emailConversationsTable.$inferSelect;
export type EmailConversationMessage = typeof emailConversationMessagesTable.$inferSelect;
export type SupportEmailConversation = typeof supportEmailConversationsTable.$inferSelect;
export type SupportEmailConversationMessage = typeof supportEmailConversationMessagesTable.$inferSelect;
export type AbandonedCartEmailTrigger = typeof abandonedCartEmailTriggersTable.$inferSelect;
export type MetaLeadEmailTrigger = typeof metaLeadEmailTriggersTable.$inferSelect;
export type UnmatchedEmailThread = typeof unmatchedEmailThreadsTable.$inferSelect;
export type UnmatchedEmailMessage = typeof unmatchedEmailMessagesTable.$inferSelect;
