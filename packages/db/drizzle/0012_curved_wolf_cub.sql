CREATE TABLE "lead_checkin_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"variant" text,
	"sent_at" timestamp with time zone,
	"provider_message_id" text,
	"cancelled_reason" text,
	"failure_reason" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead_checkin_triggers" ADD CONSTRAINT "lead_checkin_triggers_person_id_customers_id_fk" FOREIGN KEY ("person_id") REFERENCES "customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lead_checkin_triggers_person_id_key" ON "lead_checkin_triggers" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "lead_checkin_triggers_status_due_at_idx" ON "lead_checkin_triggers" USING btree ("status","due_at");