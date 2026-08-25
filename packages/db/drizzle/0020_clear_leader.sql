CREATE TABLE "unmatched_email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unmatched_email_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_address" text NOT NULL,
	"from_name" text,
	"ai_intent" text,
	"ai_summary" text,
	"suggested_match_customer_id" uuid,
	"suggested_match_confidence" text,
	"suggested_reply" text,
	"linked_customer_id" uuid,
	"status" text DEFAULT 'needs_review' NOT NULL,
	"replied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "unmatched_email_messages" ADD CONSTRAINT "unmatched_email_messages_thread_id_unmatched_email_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "unmatched_email_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_email_threads" ADD CONSTRAINT "unmatched_email_threads_suggested_match_customer_id_customers_id_fk" FOREIGN KEY ("suggested_match_customer_id") REFERENCES "customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_email_threads" ADD CONSTRAINT "unmatched_email_threads_linked_customer_id_customers_id_fk" FOREIGN KEY ("linked_customer_id") REFERENCES "customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "unmatched_email_messages_thread_id_idx" ON "unmatched_email_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "unmatched_email_threads_from_address_key" ON "unmatched_email_threads" USING btree ("from_address");