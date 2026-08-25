ALTER TABLE "app_users" ALTER COLUMN "role" SET DEFAULT 'customer_service';--> statement-breakpoint
-- role is a text column, not a native Postgres enum, so the app-level rename
-- from "employee" to "customer_service" needs an explicit data fix for any
-- row already stored with the old value.
UPDATE "app_users" SET "role" = 'customer_service' WHERE "role" = 'employee';