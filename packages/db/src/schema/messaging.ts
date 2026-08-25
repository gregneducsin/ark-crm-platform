import { pgTable, text, uuid, timestamp, boolean, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { customersTable } from "./customers";
import { questionnaireEventsTable } from "./webhooks";

/**
 * A one-time trigger link we generate and send to a lead (e.g. an
 * abandoned-questionnaire nudge). Clicking it redirects to the universal
 * Bask questionnaire URL (or its $20-off promo variant — see promoApplied)
 * and, on the first click only, arms a follow-up job due 2 hours later.
 * Only the SHA-256 hash of the raw token is ever stored — same convention as
 * session/invitation/password-reset tokens.
 */
export const intakeLinkTokensTable = pgTable(
  "intake_link_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /**
     * Which Bask URL variant this link redirects to. Decided at mint time
     * (e.g. by whether the Alexis conversation used the first_month_offer
     * topic before agreement), not at click time — the click happens hours
     * later with no memory of what was discussed.
     */
    promoApplied: text("promo_applied", { enum: ["none", "first_month_20"] }).notNull().default("none"),
    /**
     * Which conversation script this lead is on, carried from mint time
     * through to whichever follow-up job eventually logs a message for this
     * person — see follow-up-jobs.service.ts's sweep. Needed because a
     * follow-up nudge can be the very first SMS a person ever gets (e.g. a
     * Meta lead who only had an email on file when the ad-lead SMS opener
     * would have fired, but got a phone number added before their follow-up
     * came due): whoever calls createIntakeLink already knows the correct
     * value from their own context, so it's captured here rather than left
     * for the follow-up sweep to guess via conversationsTable's default,
     * which only matches abandoned-cart leads.
     */
    leadSource: text("lead_source", { enum: ["abandoned_cart", "meta_form"] }).notNull().default("abandoned_cart"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    clickedAt: timestamp("clicked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("intake_link_tokens_token_hash_key").on(t.tokenHash), index("intake_link_tokens_person_id_idx").on(t.personId)],
);

/**
 * A scheduled follow-up SMS, armed by the first click on an intake link.
 * A sweep sends `pending` jobs once due (via the SMS provider — see
 * lib/sms-provider.ts) unless the person already completed the
 * questionnaire or purchased in the meantime (`cancelled`), fully automated,
 * no manual step. `provider_check_in` fires 2 hours after the click; if it
 * sends successfully, `intake_questions_check_in` is scheduled 1 hour after
 * that (relative to the actual send, not the original click).
 */
export const followUpJobsTable = pgTable(
  "follow_up_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    intakeLinkTokenId: uuid("intake_link_token_id")
      .notNull()
      .references(() => intakeLinkTokensTable.id, { onDelete: "cascade" }),
    messageStep: text("message_step", { enum: ["provider_check_in", "intake_questions_check_in"] })
      .notNull()
      .default("provider_check_in"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    // "processing" is a transient claim state: sweepFollowUpJobs atomically
    // flips due "pending" rows to "processing" in one UPDATE before doing any
    // SMS work, so an overlapping sweep run can't claim the same row twice.
    status: text("status", { enum: ["pending", "processing", "sent", "cancelled", "failed"] }).notNull().default("pending"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    cancelledReason: text("cancelled_reason"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("follow_up_jobs_token_message_step_key").on(t.intakeLinkTokenId, t.messageStep),
    index("follow_up_jobs_status_due_at_idx").on(t.status, t.dueAt),
    index("follow_up_jobs_person_id_idx").on(t.personId),
  ],
);

/**
 * One Alexis conversation thread per customer (1:1). `leadSource` selects which
 * script the prompt builder uses — abandoned_cart assumes the patient already
 * engaged with checkout and just needs closing; meta_form is cold outreach off
 * a Meta lead-gen form and works through state/currentlyTaking/product before
 * pricing means anything. Both share the same knowledge base and guardrails.
 */
export const conversationsTable = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    leadSource: text("lead_source", { enum: ["abandoned_cart", "meta_form"] }).notNull().default("abandoned_cart"),
    /** Free-text state the patient's in, captured off the meta_form opener. Not a validated/gated value — every state is serviced. */
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
    /**
     * Which objection objectionStage belongs to — null when none is
     * currently in play. Without this, a single shared stage number can't
     * tell "still pushing back on the same objection" apart from "a
     * different objection just came up," letting an earlier objection's
     * stand-down silently apply to an unrelated one — see
     * lib/messaging/provider.ts's buildObjectionSection. Kept as a plain
     * enum (duplicated from ObjectionKey in apps/api rather than imported —
     * this package doesn't depend on apps/api) rather than a foreign key:
     * these are fixed script identifiers, not referenced rows.
     */
    objectionKey: text("objection_key", {
      enum: ["price", "think_about_it", "not_qualified", "is_legit", "no_time", "found_cheaper", "side_effects"],
    }),
    linkProvided: boolean("link_provided").notNull().default(false),
    promoOffered: boolean("promo_offered").notNull().default(false),
    /**
     * True whenever the most recent turn required staff attention — a
     * pre-check block (STOP/emergency/suitability/medical/legal), a
     * model-flagged staff_review, or a turn the guardrail rejected outright
     * (the customer got silence, not just a routed reply). Cleared by a
     * staff member reviewing the conversation, not automatically.
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
  (t) => [uniqueIndex("conversations_person_id_key").on(t.personId), index("conversations_status_idx").on(t.status)],
);

/**
 * Every message in a conversation, in order. `sentiment` is set on inbound
 * messages only, tagged by the same Claude call that produces Alexis's reply
 * (no separate classification call).
 */
export const conversationMessagesTable = pgTable(
  "conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    body: text("body").notNull(),
    sentiment: text("sentiment", { enum: ["positive", "neutral", "negative"] }),
    providerMessageId: text("provider_message_id"),
    /** Who actually wrote an outbound message — Alexis (or an automated trigger) vs a staff member typing into the reply box. Null on inbound (always the customer). */
    sentBy: text("sent_by", { enum: ["ai", "staff"] }),
    /** Which staff member actually sent it — set only when sentBy is "staff". Denormalized (not an FK), same convention as customer_notes.authorEmail, so history reads correctly even if the account is later renamed/disabled. */
    sentByStaffEmail: text("sent_by_staff_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("conversation_messages_conversation_id_idx").on(t.conversationId, t.createdAt)],
);

/**
 * Schedules the very first outbound message for a lead, armed when Bask
 * fires an `abandoned` questionnaire event. Fires 10 minutes later — fully
 * automated, 24/7, no monitored-hours window. One row per questionnaire
 * event (unique index), so a duplicate `abandoned` webhook delivery can't
 * double-send.
 */
export const abandonedCartTriggersTable = pgTable(
  "abandoned_cart_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    questionnaireEventId: uuid("questionnaire_event_id")
      .notNull()
      .references(() => questionnaireEventsTable.id, { onDelete: "cascade" }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    // "processing" is a transient claim state — see the identical comment on
    // followUpJobsTable.status.
    status: text("status", { enum: ["pending", "processing", "sent", "cancelled", "failed"] }).notNull().default("pending"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    cancelledReason: text("cancelled_reason"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("abandoned_cart_triggers_questionnaire_event_id_key").on(t.questionnaireEventId),
    index("abandoned_cart_triggers_status_due_at_idx").on(t.status, t.dueAt),
    index("abandoned_cart_triggers_person_id_idx").on(t.personId),
  ],
);

/**
 * Schedules a one-time check-in 6 days after the very first outbound
 * message Alexis ever sends a lead (armed from sendOpener in
 * abandoned-cart.service.ts and sendMetaLeadOpener in meta-lead.service.ts —
 * whichever fires first for that person). One row per person (unique
 * index), so it can only ever arm once regardless of which opener path
 * fires or how many times it's called.
 *
 * Which of the two fixed messages the sweep sends depends on the
 * conversation's currentlyTaking slot at send time (rechecked then, not at
 * arm time): still null -> ask directly; already answered -> a
 * re-engagement question instead. See lead-checkin.service.ts.
 */
export const leadCheckinTriggersTable = pgTable(
  "lead_checkin_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    // "processing" is a transient claim state — see the identical comment on
    // followUpJobsTable.status.
    status: text("status", { enum: ["pending", "processing", "sent", "cancelled", "failed"] }).notNull().default("pending"),
    // Which fixed message actually went out — recorded at send time, null until then.
    variant: text("variant", { enum: ["currently_taking", "reengagement"] }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    cancelledReason: text("cancelled_reason"),
    failureReason: text("failure_reason"),
    // A failed send gets a few retries rather than being lost permanently —
    // same reasoning and mechanism as reviewRequestTriggersTable.attemptCount.
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("lead_checkin_triggers_person_id_key").on(t.personId),
    index("lead_checkin_triggers_status_due_at_idx").on(t.status, t.dueAt),
  ],
);

/**
 * A one-time, 2-weeks-out re-engagement text, armed the moment a lead's
 * "not ready yet" hesitation (the think_about_it objection) reaches
 * STAND_DOWN — see objection-reengagement.service.ts and the standDown
 * comment on think_about_it in lib/messaging/objection-handling.ts.
 * Deliberately its own table rather than reusing leadCheckinTriggersTable:
 * that one is keyed to a lead's very first outbound message and already has
 * its own one-per-person meaning, whereas this arms (or doesn't) based on
 * something that happens mid-conversation and may never happen at all.
 * Same shape and sweep pattern as leadCheckinTriggersTable and
 * followUpJobsTable on purpose — nothing new to design here, just the
 * established pattern applied again.
 */
export const objectionReengagementTriggersTable = pgTable(
  "objection_reengagement_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    /**
     * Captured at arm time from whichever conversation (SMS or email) hit
     * the stand-down — this can be the very first SMS conversation row for
     * a lead who only ever engaged by email before this, so the sweep can't
     * rely on getOrCreateConversation's "abandoned_cart" default being
     * right. Same reasoning as leadSource on intakeLinkTokensTable.
     */
    leadSource: text("lead_source", { enum: ["abandoned_cart", "meta_form"] }).notNull().default("abandoned_cart"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    status: text("status", { enum: ["pending", "processing", "sent", "cancelled", "failed"] }).notNull().default("pending"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    cancelledReason: text("cancelled_reason"),
    failureReason: text("failure_reason"),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("objection_reengagement_triggers_person_id_key").on(t.personId),
    index("objection_reengagement_triggers_status_due_at_idx").on(t.status, t.dueAt),
  ],
);

/**
 * SMS twin of unmatchedEmailThreadsTable (email.ts) — one row per
 * unrecognized SENDER phone number (not per text), grouping every inbound
 * text from that number into one thread. Unlike email, a phone number never
 * comes with an email address attached, and customers.email is NOT NULL —
 * collectedEmail holds an email address gathered mid-conversation
 * specifically so a lead can be created, distinct from linkedCustomerId
 * (set once that lead actually exists). See recordAndClassifyUnmatchedSms
 * in unmatched-inbound-sms.service.ts.
 */
export const unmatchedSmsThreadsTable = pgTable(
  "unmatched_sms_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromPhone: text("from_phone").notNull(),
    fromName: text("from_name"),
    collectedEmail: text("collected_email"),
    aiIntent: text("ai_intent"),
    aiSummary: text("ai_summary"),
    suggestedMatchCustomerId: uuid("suggested_match_customer_id").references(() => customersTable.id, { onDelete: "set null" }),
    suggestedMatchConfidence: text("suggested_match_confidence", { enum: ["high", "medium", "low"] }),
    suggestedReply: text("suggested_reply"),
    linkedCustomerId: uuid("linked_customer_id").references(() => customersTable.id, { onDelete: "set null" }),
    status: text("status", { enum: ["needs_review", "replied", "dismissed"] }).notNull().default("needs_review"),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("unmatched_sms_threads_from_phone_key").on(t.fromPhone)],
);

/** Every message in an unmatched-sender SMS thread, in order — inbound (their texts) and outbound (the auto-ack, or a staff-approved reply). */
export const unmatchedSmsMessagesTable = pgTable(
  "unmatched_sms_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => unmatchedSmsThreadsTable.id, { onDelete: "cascade" }),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    body: text("body").notNull(),
    providerMessageId: text("provider_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("unmatched_sms_messages_thread_id_idx").on(t.threadId, t.createdAt)],
);

export type IntakeLinkToken = typeof intakeLinkTokensTable.$inferSelect;
export type FollowUpJob = typeof followUpJobsTable.$inferSelect;
export type Conversation = typeof conversationsTable.$inferSelect;
export type ConversationMessage = typeof conversationMessagesTable.$inferSelect;
export type AbandonedCartTrigger = typeof abandonedCartTriggersTable.$inferSelect;
export type LeadCheckinTrigger = typeof leadCheckinTriggersTable.$inferSelect;
export type ObjectionReengagementTrigger = typeof objectionReengagementTriggersTable.$inferSelect;
export type UnmatchedSmsThread = typeof unmatchedSmsThreadsTable.$inferSelect;
export type UnmatchedSmsMessage = typeof unmatchedSmsMessagesTable.$inferSelect;
