CREATE TABLE "support_conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"body" text NOT NULL,
	"sentiment" text,
	"provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"prescription_written" boolean DEFAULT false NOT NULL,
	"prescription_written_at" timestamp with time zone,
	"order_shipped" boolean DEFAULT false NOT NULL,
	"order_shipped_at" timestamp with time zone,
	"tracking_number" text,
	"review_requested" boolean DEFAULT false NOT NULL,
	"review_sentiment" text,
	"last_question" text,
	"pending_topic" text,
	"last_draft" text,
	"needs_attention" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_conversation_messages" ADD CONSTRAINT "support_conversation_messages_conversation_id_support_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "support_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_conversations" ADD CONSTRAINT "support_conversations_person_id_customers_id_fk" FOREIGN KEY ("person_id") REFERENCES "customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_conversation_messages_conversation_id_idx" ON "support_conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_conversations_person_id_key" ON "support_conversations" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "support_conversations_status_idx" ON "support_conversations" USING btree ("status");