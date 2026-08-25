ALTER TABLE "conversations" ADD COLUMN "needs_attention_reason" text;--> statement-breakpoint
ALTER TABLE "support_conversations" ADD COLUMN "needs_attention_reason" text;--> statement-breakpoint
ALTER TABLE "email_conversations" ADD COLUMN "needs_attention_reason" text;--> statement-breakpoint
ALTER TABLE "support_email_conversations" ADD COLUMN "needs_attention_reason" text;