CREATE TABLE "meta_lead_email_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"step" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"message_id" text,
	"cancelled_reason" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meta_lead_email_triggers" ADD CONSTRAINT "meta_lead_email_triggers_person_id_customers_id_fk" FOREIGN KEY ("person_id") REFERENCES "customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meta_lead_email_triggers_person_step_key" ON "meta_lead_email_triggers" USING btree ("person_id","step");--> statement-breakpoint
CREATE INDEX "meta_lead_email_triggers_status_due_at_idx" ON "meta_lead_email_triggers" USING btree ("status","due_at");