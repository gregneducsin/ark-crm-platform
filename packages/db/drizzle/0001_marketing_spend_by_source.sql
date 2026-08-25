ALTER TABLE "marketing_spend_weeks" DROP CONSTRAINT "msw_advertising_cost_nonneg";--> statement-breakpoint
ALTER TABLE "marketing_spend_weeks" DROP COLUMN "advertising_cost";--> statement-breakpoint
ALTER TABLE "marketing_spend_weeks" ADD COLUMN "meta_form_fill_spend" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "marketing_spend_weeks" ADD COLUMN "ecommerce_spend" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "marketing_spend_weeks" ADD CONSTRAINT "msw_meta_spend_nonneg" CHECK ("marketing_spend_weeks"."meta_form_fill_spend" >= 0);--> statement-breakpoint
ALTER TABLE "marketing_spend_weeks" ADD CONSTRAINT "msw_ecommerce_spend_nonneg" CHECK ("marketing_spend_weeks"."ecommerce_spend" >= 0);
