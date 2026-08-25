ALTER TABLE "conversations" ADD COLUMN "lead_source" text DEFAULT 'abandoned_cart' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "state" text;