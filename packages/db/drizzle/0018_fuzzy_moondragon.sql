CREATE TABLE "unmatched_inbound_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_address" text NOT NULL,
	"from_name" text,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"message_id" text,
	"ai_intent" text,
	"ai_summary" text,
	"suggested_match_customer_id" uuid,
	"suggested_match_confidence" text,
	"suggested_reply" text,
	"status" text DEFAULT 'needs_review' NOT NULL,
	"replied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "unmatched_inbound_emails" ADD CONSTRAINT "unmatched_inbound_emails_suggested_match_customer_id_customers_id_fk" FOREIGN KEY ("suggested_match_customer_id") REFERENCES "customers"("id") ON DELETE set null ON UPDATE no action;