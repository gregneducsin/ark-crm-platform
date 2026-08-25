ALTER TABLE "customers" ADD COLUMN "email_dnd" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "email_dnd_at" timestamp with time zone;