CREATE TABLE "sms_delivery_receipts" (
	"provider_message_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sms_phone_opt_outs" (
	"phone" text PRIMARY KEY NOT NULL,
	"opted_out_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_reply_work" (
	"person_id" uuid NOT NULL,
	"persona" text NOT NULL,
	"generation" uuid DEFAULT gen_random_uuid() NOT NULL,
	"held_for_staff" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "unmatched_sms_messages" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "unmatched_sms_messages" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "unmatched_sms_messages" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "unmatched_sms_threads" ADD COLUMN "pending_inbound_id" uuid;--> statement-breakpoint
ALTER TABLE "unmatched_sms_threads" ADD COLUMN "onboarding_held" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "unmatched_sms_threads" ADD COLUMN "delivery_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_conversation_messages" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_conversation_messages" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_conversation_messages" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sms_reply_work" ADD CONSTRAINT "sms_reply_work_person_id_customers_id_fk" FOREIGN KEY ("person_id") REFERENCES "customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_reply_work_person_persona_key" ON "sms_reply_work" USING btree ("person_id","persona");--> statement-breakpoint
CREATE INDEX "unmatched_sms_threads_pending_idx" ON "unmatched_sms_threads" USING btree ("updated_at") WHERE "unmatched_sms_threads"."pending_inbound_id" is not null and not "unmatched_sms_threads"."onboarding_held";