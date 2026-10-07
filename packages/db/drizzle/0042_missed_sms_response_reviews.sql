CREATE TABLE "missed_sms_response_reviews" (
  "persona" text NOT NULL,
  "conversation_id" uuid NOT NULL,
  "inbound_id" uuid NOT NULL,
  "reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "missed_sms_response_reviews_key" UNIQUE("persona", "conversation_id", "inbound_id")
);
