/**
 * Migration smoke test: fresh isolated schema -> run migrations -> assert
 * every expected table exists. This is the single highest-value test for
 * this package, since a broken migration is the prototype's most common
 * historical failure mode (see ARCHITECTURE.md).
 */
import crypto from "crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCHEMA_PATTERN = /^_ark_test_[0-9]+_[a-f0-9]+$/;

const EXPECTED_TABLES = [
  "__drizzle_migrations",
  "app_users",
  "user_sessions",
  "user_invitation_tokens",
  "password_reset_tokens",
  "user_audit_events",
  "customers",
  "external_identities",
  "purchases",
  "purchase_classification_audits",
  "webhook_events",
  "questionnaire_events",
  "failed_payment_events",
  "employees",
  "payroll_weeks",
  "employee_weekly_hours",
  "employee_bonuses",
  "payroll_audit_events",
  "marketing_spend_weeks",
  "intake_link_tokens",
  "follow_up_jobs",
  "conversations",
  "conversation_messages",
  "abandoned_cart_triggers",
  "support_conversations",
  "support_conversation_messages",
  "review_request_triggers",
  "lead_checkin_triggers",
  "email_conversations",
  "email_conversation_messages",
  "support_email_conversations",
  "support_email_conversation_messages",
  "abandoned_cart_email_triggers",
  "meta_lead_email_triggers",
  "unmatched_email_threads",
  "unmatched_email_messages",
  "objection_reengagement_triggers",
  "unmatched_sms_threads",
  "unmatched_sms_messages",
  "customer_notes",
].sort();

let testSchema: string;
let adminClient: Client;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set to run db tests.");
  }

  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString("hex");
  testSchema = `_ark_test_${ts}_${rand}`;
  if (!SCHEMA_PATTERN.test(testSchema)) {
    throw new Error(`Generated schema name failed validation: ${testSchema}`);
  }

  adminClient = new Client({ connectionString: process.env.DATABASE_URL });
  await adminClient.connect();
  await adminClient.query(`CREATE SCHEMA "${testSchema}"`);

  process.env.NODE_ENV = "test";
  process.env.POSTGRES_SCHEMA = testSchema;

  // Dynamic import so ./index.js reads POSTGRES_SCHEMA *after* it's set above
  // (the pool's search_path is fixed at module-load time).
  const { runMigrations } = await import("./migrate.js");
  await runMigrations();
}, 30_000);

afterAll(async () => {
  if (testSchema && SCHEMA_PATTERN.test(testSchema)) {
    await adminClient.query(`DROP SCHEMA "${testSchema}" CASCADE`);
  }
  await adminClient.end();
  const { pool } = await import("./index.js");
  await pool.end();
});

describe("migrate", () => {
  it("creates every expected table in the isolated schema", async () => {
    const result = await adminClient.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [testSchema],
    );
    const actual = result.rows.map((r) => r.table_name).sort();
    expect(actual).toEqual(EXPECTED_TABLES);
  });

  it("creates the person_number and employee_number sequences", async () => {
    const result = await adminClient.query<{ sequence_name: string }>(
      `SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = $1 ORDER BY sequence_name`,
      [testSchema],
    );
    const names = result.rows.map((r) => r.sequence_name);
    // Plus drizzle's own tracking-table sequence and serial-column-implied
    // sequences (purchases.id, employee_weekly_hours doesn't use serial —
    // only purchases does) — assert the two we care about are present rather
    // than asserting the exact full set, which would break every time a new
    // serial column is added.
    expect(names).toContain("person_number_seq");
    expect(names).toContain("employee_number_seq");
  });

  it("is idempotent — running twice is a safe no-op", async () => {
    const { runMigrations } = await import("./migrate.js");
    await expect(runMigrations()).resolves.not.toThrow();
  });
});
