CREATE TABLE "app_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"normalized_email" text NOT NULL,
	"first_name" text DEFAULT '' NOT NULL,
	"last_name" text DEFAULT '' NOT NULL,
	"password_hash" text,
	"role" text DEFAULT 'employee' NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"employee_id" uuid,
	"invited_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"target_user_id" uuid,
	"action" text NOT NULL,
	"previous_values" jsonb,
	"new_values" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_invitation_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_number" text DEFAULT ('PER-' || lpad(nextval('person_number_seq')::text, 6, '0')) NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"lead_received_date" date NOT NULL,
	"lead_created_at" timestamp with time zone,
	"lead_type" text DEFAULT 'Other / Unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"system" text NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_classification_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_id" integer NOT NULL,
	"changed_by" text NOT NULL,
	"previous_classification" text,
	"new_classification" text NOT NULL,
	"previous_source" text,
	"new_source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"purchase_date" date NOT NULL,
	"order_number" text NOT NULL,
	"product_name" text NOT NULL,
	"amount_paid" numeric(10, 2) NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"ecommerce_order_id" text,
	"order_classification" text,
	"order_classification_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "failed_payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_event_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"person_id" uuid,
	"external_person_id" text NOT NULL,
	"amount" numeric(12, 2),
	"failure_date" timestamp with time zone NOT NULL,
	"payment_method_type" text,
	"card_brand" text,
	"card_last4" text,
	"transaction_response" text,
	"source_status" text,
	"test_mode" boolean DEFAULT false NOT NULL,
	"resolution_status" text DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"notes" text,
	"recovered_purchase_id" integer,
	"recovered_transaction_id" text,
	"raw_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questionnaire_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"questionnaire_id" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone,
	"last_event_at" timestamp with time zone NOT NULL,
	"external_person_id" text,
	"source" text DEFAULT 'questionnaire' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_event_id" text NOT NULL,
	"person_id" uuid,
	"status" text DEFAULT 'received' NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"error_message" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "employee_bonuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_week_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"description" text NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_weekly_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_week_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"hours_worked" numeric(7, 2) NOT NULL,
	"hourly_rate_snapshot" numeric(10, 2) NOT NULL,
	"hourly_earnings" numeric(12, 2) NOT NULL,
	"total_deals" integer,
	"commission_amount" numeric(12, 2),
	"commission_notes" text,
	"notes" text,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_number" text DEFAULT ('EMP-' || lpad(nextval('employee_number_seq')::text, 6, '0')) NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"hourly_rate" numeric(10, 2) NOT NULL,
	"hire_date" date,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_spend_weeks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_start" date NOT NULL,
	"week_end" date NOT NULL,
	"advertising_cost" numeric(12, 2) NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "msw_advertising_cost_nonneg" CHECK ("marketing_spend_weeks"."advertising_cost" >= 0),
	CONSTRAINT "msw_week_start_is_friday" CHECK (extract(isodow from "marketing_spend_weeks"."week_start") = 5),
	CONSTRAINT "msw_week_end_is_thursday" CHECK (extract(isodow from "marketing_spend_weeks"."week_end") = 4),
	CONSTRAINT "msw_week_span" CHECK ("marketing_spend_weeks"."week_end" = "marketing_spend_weeks"."week_start" + 6)
);
--> statement-breakpoint
CREATE TABLE "payroll_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_week_id" uuid,
	"employee_id" uuid,
	"action" text NOT NULL,
	"performed_by" text NOT NULL,
	"previous_values" jsonb,
	"new_values" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_weeks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_start" date NOT NULL,
	"week_end" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"paid_at" timestamp with time zone,
	"paid_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_users" ADD CONSTRAINT "app_users_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_audit_events" ADD CONSTRAINT "user_audit_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_audit_events" ADD CONSTRAINT "user_audit_events_target_user_id_app_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invitation_tokens" ADD CONSTRAINT "user_invitation_tokens_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_person_id_customers_id_fk" FOREIGN KEY ("person_id") REFERENCES "customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_classification_audits" ADD CONSTRAINT "purchase_classification_audits_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failed_payment_events" ADD CONSTRAINT "failed_payment_events_person_id_customers_id_fk" FOREIGN KEY ("person_id") REFERENCES "customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failed_payment_events" ADD CONSTRAINT "failed_payment_events_recovered_purchase_id_purchases_id_fk" FOREIGN KEY ("recovered_purchase_id") REFERENCES "purchases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_events" ADD CONSTRAINT "questionnaire_events_person_id_customers_id_fk" FOREIGN KEY ("person_id") REFERENCES "customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_person_id_customers_id_fk" FOREIGN KEY ("person_id") REFERENCES "customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_bonuses" ADD CONSTRAINT "employee_bonuses_payroll_week_id_payroll_weeks_id_fk" FOREIGN KEY ("payroll_week_id") REFERENCES "payroll_weeks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_bonuses" ADD CONSTRAINT "employee_bonuses_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_weekly_hours" ADD CONSTRAINT "employee_weekly_hours_payroll_week_id_payroll_weeks_id_fk" FOREIGN KEY ("payroll_week_id") REFERENCES "payroll_weeks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_weekly_hours" ADD CONSTRAINT "employee_weekly_hours_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_users_normalized_email_key" ON "app_users" USING btree ("normalized_email");--> statement-breakpoint
CREATE UNIQUE INDEX "app_users_employee_id_key" ON "app_users" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "app_users_role_idx" ON "app_users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "app_users_status_idx" ON "app_users" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_audit_events_actor_user_id_idx" ON "user_audit_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "user_audit_events_target_user_id_idx" ON "user_audit_events" USING btree ("target_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_invitation_tokens_token_hash_key" ON "user_invitation_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "user_invitation_tokens_user_id_idx" ON "user_invitation_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_sessions_token_hash_key" ON "user_sessions" USING btree ("session_token_hash");--> statement-breakpoint
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_sessions_expires_at_idx" ON "user_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_person_number_key" ON "customers" USING btree ("person_number");--> statement-breakpoint
CREATE INDEX "customers_email_idx" ON "customers" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_system_external_id_key" ON "external_identities" USING btree ("system","external_id");--> statement-breakpoint
CREATE INDEX "external_identities_person_id_idx" ON "external_identities" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "purchase_classification_audits_purchase_id_idx" ON "purchase_classification_audits" USING btree ("purchase_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_ecommerce_order_id_key" ON "purchases" USING btree ("ecommerce_order_id");--> statement-breakpoint
CREATE INDEX "purchases_customer_id_idx" ON "purchases" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "failed_payment_events_external_event_id_key" ON "failed_payment_events" USING btree ("external_event_id");--> statement-breakpoint
CREATE INDEX "failed_payment_events_person_id_idx" ON "failed_payment_events" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "failed_payment_events_failure_date_idx" ON "failed_payment_events" USING btree ("failure_date");--> statement-breakpoint
CREATE INDEX "failed_payment_events_resolution_status_idx" ON "failed_payment_events" USING btree ("resolution_status");--> statement-breakpoint
CREATE INDEX "failed_payment_events_transaction_id_idx" ON "failed_payment_events" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "questionnaire_events_person_questionnaire_idx" ON "questionnaire_events" USING btree ("person_id","questionnaire_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_source_external_event_id_key" ON "webhook_events" USING btree ("source","external_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_person_id_idx" ON "webhook_events" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "employee_bonuses_payroll_week_id_idx" ON "employee_bonuses" USING btree ("payroll_week_id");--> statement-breakpoint
CREATE INDEX "employee_bonuses_employee_id_idx" ON "employee_bonuses" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_weekly_hours_week_employee_key" ON "employee_weekly_hours" USING btree ("payroll_week_id","employee_id");--> statement-breakpoint
CREATE INDEX "employee_weekly_hours_payroll_week_id_idx" ON "employee_weekly_hours" USING btree ("payroll_week_id");--> statement-breakpoint
CREATE INDEX "employee_weekly_hours_employee_id_idx" ON "employee_weekly_hours" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_employee_number_key" ON "employees" USING btree ("employee_number");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_email_key" ON "employees" USING btree ("email");--> statement-breakpoint
CREATE INDEX "employees_status_idx" ON "employees" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_spend_weeks_week_start_key" ON "marketing_spend_weeks" USING btree ("week_start");--> statement-breakpoint
CREATE INDEX "marketing_spend_weeks_week_end_idx" ON "marketing_spend_weeks" USING btree ("week_end");--> statement-breakpoint
CREATE INDEX "payroll_audit_events_payroll_week_id_idx" ON "payroll_audit_events" USING btree ("payroll_week_id");--> statement-breakpoint
CREATE INDEX "payroll_audit_events_employee_id_idx" ON "payroll_audit_events" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_weeks_week_start_key" ON "payroll_weeks" USING btree ("week_start");--> statement-breakpoint
CREATE INDEX "payroll_weeks_status_idx" ON "payroll_weeks" USING btree ("status");