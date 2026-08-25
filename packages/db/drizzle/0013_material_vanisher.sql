ALTER TABLE "customers" ADD COLUMN "dnd" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "dnd_at" timestamp with time zone;