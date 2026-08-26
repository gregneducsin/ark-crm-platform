ALTER TABLE "email_conversations" ADD COLUMN "receiving_address" text;--> statement-breakpoint
ALTER TABLE "support_email_conversations" ADD COLUMN "receiving_address" text;--> statement-breakpoint
ALTER TABLE "unmatched_email_threads" ADD COLUMN "receiving_address" text;