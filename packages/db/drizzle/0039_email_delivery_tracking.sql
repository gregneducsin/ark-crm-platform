ALTER TABLE "email_conversation_messages" ADD COLUMN "delivery_status" text;
--> statement-breakpoint
ALTER TABLE "email_conversation_messages" ADD COLUMN "sent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "email_conversation_messages" ADD COLUMN "inbound_event_id" text;
--> statement-breakpoint
ALTER TABLE "email_conversation_messages" ADD COLUMN "handled_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX "email_conversation_messages_inbound_event_key" ON "email_conversation_messages" USING btree ("conversation_id","inbound_event_id");
--> statement-breakpoint
ALTER TABLE "support_email_conversation_messages" ADD COLUMN "delivery_status" text;
--> statement-breakpoint
ALTER TABLE "support_email_conversation_messages" ADD COLUMN "sent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "support_email_conversation_messages" ADD COLUMN "inbound_event_id" text;
--> statement-breakpoint
ALTER TABLE "support_email_conversation_messages" ADD COLUMN "handled_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX "support_email_conversation_messages_inbound_event_key" ON "support_email_conversation_messages" USING btree ("conversation_id","inbound_event_id");
