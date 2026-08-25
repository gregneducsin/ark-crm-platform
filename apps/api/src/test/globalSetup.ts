/**
 * Vitest global setup — runs once before any test file. Creates an isolated
 * Postgres schema, applies migrations into it, and hands the schema name to
 * every worker via inject("testSchema"). Mirrors packages/db's own test
 * harness (see packages/db/src/migrate.test.ts).
 */
import crypto from "crypto";
import { Client } from "pg";
import type { ProvidedContext } from "vitest";

declare module "vitest" {
  interface ProvidedContext {
    testSchema: string;
  }
}

type SetupContext = {
  provide: <T extends keyof ProvidedContext & string>(key: T, value: ProvidedContext[T]) => void;
};

const SCHEMA_PATTERN = /^_ark_test_[0-9]+_[a-f0-9]+$/;

let testSchema: string;
let adminClient: Client;

export async function setup({ provide }: SetupContext): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set to run tests.");
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

  const { runMigrations } = await import("@luma/db/migrate");
  await runMigrations();

  provide("testSchema", testSchema);
}

export async function teardown(): Promise<void> {
  if (testSchema && SCHEMA_PATTERN.test(testSchema)) {
    await adminClient.query(`DROP SCHEMA "${testSchema}" CASCADE`);
  }
  await adminClient.end();
}
