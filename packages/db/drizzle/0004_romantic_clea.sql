DROP INDEX "follow_up_jobs_intake_link_token_id_key";--> statement-breakpoint
ALTER TABLE "follow_up_jobs" ADD COLUMN "message_step" text DEFAULT 'provider_check_in' NOT NULL;--> statement-breakpoint
ALTER TABLE "follow_up_jobs" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "follow_up_jobs" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "follow_up_jobs" ADD COLUMN "failure_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "follow_up_jobs_token_message_step_key" ON "follow_up_jobs" USING btree ("intake_link_token_id","message_step");--> statement-breakpoint
ALTER TABLE "follow_up_jobs" DROP COLUMN "job_type";--> statement-breakpoint
ALTER TABLE "follow_up_jobs" DROP COLUMN "ready_at";