ALTER TABLE "conversation_messages" ADD COLUMN "sent_by_staff_email" text;--> statement-breakpoint
ALTER TABLE "support_conversation_messages" ADD COLUMN "sent_by_staff_email" text;--> statement-breakpoint
ALTER TABLE "email_conversation_messages" ADD COLUMN "sent_by_staff_email" text;--> statement-breakpoint
ALTER TABLE "support_email_conversation_messages" ADD COLUMN "sent_by_staff_email" text;