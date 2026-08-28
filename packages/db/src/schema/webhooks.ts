import { pgTable, text, uuid, integer, numeric, boolean, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { customersTable } from "./customers";
import { purchasesTable } from "./purchases";

/**
 * Raw inbound-webhook event log, one row per delivery attempt. `externalEventId`
 * is the idempotency key each webhook handler uses to reject duplicate deliveries.
 */
export const webhookEventsTable = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source", {
      enum: [
        "ghl_lead",
        "bask_order",
        "bask_questionnaire",
        "bask_payment_failed",
        "bask_payment_succeeded",
        "bask_prescription_written",
        "bask_order_shipped",
        "iblusend_message",
        "email_inbound",
      ],
    }).notNull(),
    externalEventId: text("external_event_id").notNull(),
    personId: uuid("person_id").references(() => customersTable.id, { onDelete: "set null" }),
    status: text("status", { enum: ["received", "processed", "failed"] }).notNull().default("received"),
    rawPayload: jsonb("raw_payload").notNull(),
    errorMessage: text("error_message"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("webhook_events_source_external_event_id_key").on(t.source, t.externalEventId),
    index("webhook_events_person_id_idx").on(t.personId),
  ],
);

export const questionnaireEventsTable = pgTable(
  "questionnaire_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    questionnaireId: text("questionnaire_id").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }).notNull(),
    externalPersonId: text("external_person_id"),
    source: text("source").notNull().default("questionnaire"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("questionnaire_events_person_questionnaire_idx").on(t.personId, t.questionnaireId),
  ],
);

export const failedPaymentEventsTable = pgTable(
  "failed_payment_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    externalEventId: text("external_event_id").notNull(),
    transactionId: text("transaction_id").notNull(),
    personId: uuid("person_id").references(() => customersTable.id, { onDelete: "set null" }),
    externalPersonId: text("external_person_id").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }),
    failureDate: timestamp("failure_date", { withTimezone: true }).notNull(),
    paymentMethodType: text("payment_method_type"),
    cardBrand: text("card_brand"),
    cardLast4: text("card_last4"),
    transactionResponse: text("transaction_response"),
    sourceStatus: text("source_status"),
    testMode: boolean("test_mode").notNull().default(false),
    resolutionStatus: text("resolution_status").notNull().default("open"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    notes: text("notes"),
    recoveredPurchaseId: integer("recovered_purchase_id").references(() => purchasesTable.id, { onDelete: "set null" }),
    recoveredTransactionId: text("recovered_transaction_id"),
    rawPayload: jsonb("raw_payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("failed_payment_events_external_event_id_key").on(t.externalEventId),
    index("failed_payment_events_person_id_idx").on(t.personId),
    index("failed_payment_events_failure_date_idx").on(t.failureDate),
    index("failed_payment_events_resolution_status_idx").on(t.resolutionStatus),
    index("failed_payment_events_transaction_id_idx").on(t.transactionId),
  ],
);

export type WebhookEvent = typeof webhookEventsTable.$inferSelect;
export type InsertWebhookEvent = typeof webhookEventsTable.$inferInsert;
