CREATE TABLE "abandoned_cart_email_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"questionnaire_event_id" uuid NOT NULL,
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
ALTER TABLE "abandoned_cart_email_triggers" ADD CONSTRAINT "abandoned_cart_email_triggers_person_id_customers_id_fk" FOREIGN KEY ("person_id") REFERENCES "customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abandoned_cart_email_triggers" ADD CONSTRAINT "abandoned_cart_email_triggers_questionnaire_event_id_questionnaire_events_id_fk" FOREIGN KEY ("questionnaire_event_id") REFERENCES "questionnaire_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "abandoned_cart_email_triggers_event_step_key" ON "abandoned_cart_email_triggers" USING btree ("questionnaire_event_id","step");--> statement-breakpoint
CREATE INDEX "abandoned_cart_email_triggers_status_due_at_idx" ON "abandoned_cart_email_triggers" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "abandoned_cart_email_triggers_person_id_idx" ON "abandoned_cart_email_triggers" USING btree ("person_id");