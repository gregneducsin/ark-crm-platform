CREATE TABLE "abandoned_cart_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"questionnaire_event_id" uuid NOT NULL,
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
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"body" text NOT NULL,
	"sentiment" text,
	"provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"selected_product" text,
	"currently_taking" text,
	"wants_process_explanation" text,
	"has_time_for_intake" text,
	"wants_plan_inclusions" text,
	"ready_for_form" text,
	"last_question" text,
	"pending_topic" text,
	"last_draft" text,
	"objection_stage" integer DEFAULT 0 NOT NULL,
	"link_provided" boolean DEFAULT false NOT NULL,
	"promo_offered" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "abandoned_cart_triggers" ADD CONSTRAINT "abandoned_cart_triggers_person_id_customers_id_fk" FOREIGN KEY ("person_id") REFERENCES "customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abandoned_cart_triggers" ADD CONSTRAINT "abandoned_cart_triggers_questionnaire_event_id_questionnaire_events_id_fk" FOREIGN KEY ("questionnaire_event_id") REFERENCES "questionnaire_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_person_id_customers_id_fk" FOREIGN KEY ("person_id") REFERENCES "customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "abandoned_cart_triggers_questionnaire_event_id_key" ON "abandoned_cart_triggers" USING btree ("questionnaire_event_id");--> statement-breakpoint
CREATE INDEX "abandoned_cart_triggers_status_due_at_idx" ON "abandoned_cart_triggers" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "abandoned_cart_triggers_person_id_idx" ON "abandoned_cart_triggers" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "conversation_messages_conversation_id_idx" ON "conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_person_id_key" ON "conversations" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "conversations_status_idx" ON "conversations" USING btree ("status");