ALTER TABLE "conversation_messages" ADD COLUMN "media_urls" jsonb;--> statement-breakpoint
ALTER TABLE "unmatched_sms_messages" ADD COLUMN "media_urls" jsonb;--> statement-breakpoint
ALTER TABLE "support_conversation_messages" ADD COLUMN "media_urls" jsonb;