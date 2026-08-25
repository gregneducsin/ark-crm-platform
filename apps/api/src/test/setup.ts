/**
 * Runs in every worker, before the test file's own imports are evaluated
 * (top-level await here blocks the import chain until this resolves) — sets
 * POSTGRES_SCHEMA/NODE_ENV so @luma/db's pool picks up the isolated test
 * schema the moment it's first imported by app.ts or any service.
 */
import { inject } from "vitest";

const testSchema = inject("testSchema");
if (!testSchema) {
  throw new Error("testSchema was not provided by globalSetup — did globalSetup run?");
}

process.env.NODE_ENV = "test";
process.env.POSTGRES_SCHEMA = testSchema;
