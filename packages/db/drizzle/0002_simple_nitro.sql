CREATE TABLE "follow_up_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"intake_link_token_id" uuid NOT NULL,
	"job_type" text DEFAULT 'abandoned_intake_followup' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"ready_at" timestamp with time zone,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_link_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"clicked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "follow_up_jobs" ADD CONSTRAINT "follow_up_jobs_person_id_customers_id_fk" FOREIGN KEY ("person_id") REFERENCES "customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_jobs" ADD CONSTRAINT "follow_up_jobs_intake_link_token_id_intake_link_tokens_id_fk" FOREIGN KEY ("intake_link_token_id") REFERENCES "intake_link_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_link_tokens" ADD CONSTRAINT "intake_link_tokens_person_id_customers_id_fk" FOREIGN KEY ("person_id") REFERENCES "customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "follow_up_jobs_intake_link_token_id_key" ON "follow_up_jobs" USING btree ("intake_link_token_id");--> statement-breakpoint
CREATE INDEX "follow_up_jobs_status_due_at_idx" ON "follow_up_jobs" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "follow_up_jobs_person_id_idx" ON "follow_up_jobs" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_link_tokens_token_hash_key" ON "intake_link_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "intake_link_tokens_person_id_idx" ON "intake_link_tokens" USING btree ("person_id");