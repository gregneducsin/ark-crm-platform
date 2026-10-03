ALTER TABLE "customers" ADD COLUMN "ai_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "ai_paused_at" timestamp with time zone;
