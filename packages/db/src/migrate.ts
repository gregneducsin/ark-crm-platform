/**
 * Single migration entrypoint. Applies pending migration files from ./drizzle
 * using drizzle-orm's own tracked migrator (idempotency is guaranteed by
 * drizzle's __drizzle_migrations tracking table — no hand-written
 * schema-definition mechanism exists anywhere else in this repo).
 *
 * Guarded by a Postgres advisory lock so multiple instances booting
 * concurrently serialize safely: the first acquires the lock and applies
 * pending migrations; the rest block, then find nothing pending, and proceed.
 *
 * Run as a discrete step before the API starts serving traffic (see
 * apps/api's Docker entrypoint / this repo's CI workflow) — never opportunistically
 * per-request.
 *
 * IMPORTANT: drizzle's tracking table normally lives in a fixed "drizzle"
 * schema shared by the whole database — it is NOT scoped by the connection's
 * search_path. That's correct and desired for normal (single-schema)
 * operation, but it silently breaks per-schema test isolation: a schema that
 * has never seen a migration would still be treated as "already migrated"
 * because the tracking table is shared. When POSTGRES_SCHEMA is set (test
 * isolation only — see ./index.ts), the tracking table is pointed at that
 * same isolated schema instead, so each test run's migration state is fully
 * self-contained.
 */
import path from "path";
import { fileURLToPath } from "url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./index.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Fixed advisory lock key, unique to this project. Arbitrary, must fit int8.
const ADVISORY_LOCK_KEY = 4271_9001_337n;

// Unqualified names — correctly follow the connection's search_path in both
// production (public) and test isolation (POSTGRES_SCHEMA). See the
// PERSON_NUMBER_SEQ_NAME / EMPLOYEE_NUMBER_SEQ_NAME comments in
// ./schema/customers.ts and ./schema/payroll.ts for why these aren't
// declared via drizzle-kit's pgSequence().
const SEQUENCE_BOOTSTRAP_SQL = [
  `CREATE SEQUENCE IF NOT EXISTS person_number_seq`,
  `CREATE SEQUENCE IF NOT EXISTS employee_number_seq`,
];

async function runMigrations(): Promise<void> {
  const testSchema = process.env.POSTGRES_SCHEMA;

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [ADVISORY_LOCK_KEY.toString()]);
    try {
      for (const stmt of SEQUENCE_BOOTSTRAP_SQL) {
        await client.query(stmt);
      }
      await migrate(db, {
        migrationsFolder: path.join(dirname, "../drizzle"),
        ...(testSchema ? { migrationsSchema: testSchema } : {}),
      });
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [ADVISORY_LOCK_KEY.toString()]);
    }
  } finally {
    client.release();
  }
}

const isMain = process.argv[1] === new URL(import.meta.url).pathname;
if (isMain) {
  runMigrations()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log("migrate: all pending migrations applied");
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("migrate: fatal error", err);
      process.exit(1);
    });
}

export { runMigrations };
