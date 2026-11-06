CREATE TABLE email_campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL, subject text NOT NULL, html text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','paused','completed')),
 per_hour integer NOT NULL DEFAULT 20 CHECK (per_hour BETWEEN 1 AND 60),
 next_send_at timestamptz NOT NULL DEFAULT now(),
 test_status text NOT NULL DEFAULT 'not_sent', test_message_id text,
 test_requested_at timestamptz, test_sent_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL
);
--> statement-breakpoint
CREATE TABLE email_campaign_recipients (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 campaign_id uuid NOT NULL REFERENCES email_campaigns(id),
 person_id uuid REFERENCES customers(id) ON DELETE SET NULL,
 email text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','skipped','failed','unknown')),
 reason text, provider_message_id text, attempted_at timestamptz, sent_at timestamptz,
 UNIQUE(campaign_id, email)
);
--> statement-breakpoint
CREATE INDEX email_campaign_queue_idx ON email_campaign_recipients(campaign_id, status);
