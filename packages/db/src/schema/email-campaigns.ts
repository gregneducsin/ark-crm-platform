import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { customersTable } from "./customers";
export const emailCampaignsTable = pgTable("email_campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  html: text("html").notNull(),
  status: text("status").notNull().default("draft"),
  perHour: integer("per_hour").notNull().default(20),
  nextSendAt: timestamp("next_send_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  testStatus: text("test_status").notNull().default("not_sent"),
  testMessageId: text("test_message_id"),
  testRequestedAt: timestamp("test_requested_at", { withTimezone: true }),
  testSentAt: timestamp("test_sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdBy: text("created_by").notNull(),
});
export const emailCampaignRecipientsTable = pgTable(
  "email_campaign_recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => emailCampaignsTable.id),
    personId: uuid("person_id").references(() => customersTable.id, {
      onDelete: "set null",
    }),
    email: text("email").notNull(),
    status: text("status").notNull().default("pending"),
    reason: text("reason"),
    providerMessageId: text("provider_message_id"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("email_campaign_recipients_campaign_id_email_key").on(
      t.campaignId,
      t.email,
    ),
    index("email_campaign_queue_idx").on(t.campaignId, t.status),
  ],
);
