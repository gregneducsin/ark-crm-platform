ALTER TABLE "conversation_messages" ADD COLUMN "sent_by" text;--> statement-breakpoint
ALTER TABLE "support_conversation_messages" ADD COLUMN "sent_by" text;--> statement-breakpoint
ALTER TABLE "email_conversation_messages" ADD COLUMN "sent_by" text;--> statement-breakpoint
ALTER TABLE "support_email_conversation_messages" ADD COLUMN "sent_by" text;