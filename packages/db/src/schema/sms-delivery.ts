import { pgTable, text, uuid, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { customersTable } from "./customers";

export const smsPhoneOptOutsTable = pgTable("sms_phone_opt_outs", {
  phone: text("phone").primaryKey(),
  optedOutAt: timestamp("opted_out_at", { withTimezone: true }).notNull().defaultNow(),
});

// Receipts can arrive before the HTTP send request returns its message ID.
export const smsDeliveryReceiptsTable = pgTable("sms_delivery_receipts", {
  providerMessageId: text("provider_message_id").primaryKey(),
  status: text("status", { enum: ["sent", "delivered", "read", "failed"] }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  readAt: timestamp("read_at", { withTimezone: true }),
});

export const smsReplyWorkTable = pgTable("sms_reply_work", {
  personId: uuid("person_id").notNull().references(() => customersTable.id, { onDelete: "cascade" }),
  persona: text("persona", { enum: ["sales", "support"] }).notNull(),
  generation: uuid("generation").notNull().defaultRandom(),
  heldForStaff: boolean("held_for_staff").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("sms_reply_work_person_persona_key").on(t.personId, t.persona)]);
