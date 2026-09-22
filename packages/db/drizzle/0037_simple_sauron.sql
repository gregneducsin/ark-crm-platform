ALTER TABLE "conversations" ADD COLUMN "plan_length" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "dosage_preference" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "start_timing_preference" text;--> statement-breakpoint
ALTER TABLE "email_conversations" ADD COLUMN "plan_length" text;--> statement-breakpoint
ALTER TABLE "email_conversations" ADD COLUMN "dosage_preference" text;--> statement-breakpoint
ALTER TABLE "email_conversations" ADD COLUMN "start_timing_preference" text;