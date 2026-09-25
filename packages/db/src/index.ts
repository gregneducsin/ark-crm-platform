import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
}

// Test-isolation support: when POSTGRES_SCHEMA is set, every connection in
// the pool sets its search_path to that schema only (no fallback to public).
// Only ever set by the test harness — validated strictly so a misconfigured
// environment fails loudly instead of silently touching the wrong schema.
const testSchema = process.env.POSTGRES_SCHEMA;
if (testSchema) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("POSTGRES_SCHEMA must only be set when NODE_ENV=test.");
  }
  if (!/^_ark_test_[0-9]+_[a-f0-9]+$/.test(testSchema)) {
    throw new Error(`Invalid POSTGRES_SCHEMA value: "${testSchema}"`);
  }
}

const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  ...(testSchema
    ? {
        options: `-c search_path=${testSchema}`,
      }
    : {}),
};

export const pool = new Pool(poolConfig);

// Locks stay checked out while their callbacks use db/pool. Keeping them in
// a separate bounded pool prevents lock holders/waiters from exhausting the
// connections those callbacks need to finish. Same database and test schema.
export const personLockPool = new Pool({ ...poolConfig, max: 10 });

export const db = drizzle(pool, { schema });

export * from "./schema/index.js";
