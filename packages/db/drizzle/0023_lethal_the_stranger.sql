CREATE TABLE "objection_reengagement_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"provider_message_id" text,
	"cancelled_reason" text,
	"failure_reason" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "objection_key" text;--> statement-breakpoint
ALTER TABLE "email_conversations" ADD COLUMN "objection_key" text;--> statement-breakpoint
ALTER TABLE "objection_reengagement_triggers" ADD CONSTRAINT "objection_reengagement_triggers_person_id_customers_id_fk" FOREIGN KEY ("person_id") REFERENCES "customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "objection_reengagement_triggers_person_id_key" ON "objection_reengagement_triggers" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "objection_reengagement_triggers_status_due_at_idx" ON "objection_reengagement_triggers" USING btree ("status","due_at");