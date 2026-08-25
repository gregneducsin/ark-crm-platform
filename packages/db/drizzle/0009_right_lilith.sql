CREATE TABLE "review_request_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"provider_message_id" text,
	"cancelled_reason" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_request_triggers" ADD CONSTRAINT "review_request_triggers_person_id_customers_id_fk" FOREIGN KEY ("person_id") REFERENCES "customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_request_triggers_person_id_key" ON "review_request_triggers" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "review_request_triggers_status_due_at_idx" ON "review_request_triggers" USING btree ("status","due_at");