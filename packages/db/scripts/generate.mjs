#!/usr/bin/env node
/**
 * Wraps `drizzle-kit generate` and strips the hardcoded `"public".` schema
 * qualifier drizzle-kit bakes into generated DDL (CREATE SEQUENCE, and every
 * FOREIGN KEY ... REFERENCES clause) regardless of the generating
 * connection's search_path.
 *
 * Why this matters: table CREATE statements are correctly left unqualified
 * by drizzle-kit (relying on search_path), but sequences and FK references
 * are NOT — they're hardcoded to whatever schema was "current" when
 * `generate` ran (always "public" here). That inconsistency is harmless in
 * normal production use (everything lives in "public" anyway, so explicit
 * and implicit resolution agree), but it silently breaks schema-based test
 * isolation: a fresh isolated test schema's FK constraints would validate
 * against the real "public" tables instead of the isolated schema's own
 * tables, either failing outright (see the `_ark_test_*` schema having no
 * matching row in `public`) or, worse, succeeding against the wrong data.
 *
 * Fixed once here, at generation time, rather than as a runtime SQL
 * transform in migrate.ts — the checked-in migration file is simply correct
 * and schema-agnostic from the start; no second code path needed to apply
 * it, matching this repo's "one migration mechanism" principle.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const dbRoot = path.join(dirname, "..");
const drizzleDir = path.join(dbRoot, "drizzle");

const before = new Set(readdirSync(drizzleDir).filter((f) => f.endsWith(".sql")));

execFileSync("drizzle-kit", ["generate", "--config", "./drizzle.config.ts"], {
  cwd: dbRoot,
  stdio: "inherit",
});

const after = readdirSync(drizzleDir).filter((f) => f.endsWith(".sql"));
const newFiles = after.filter((f) => !before.has(f));

if (newFiles.length === 0) {
  console.log("generate: no new migration file produced (schema unchanged) — nothing to sanitize.");
  process.exit(0);
}

for (const file of newFiles) {
  const filePath = path.join(drizzleDir, file);
  const original = readFileSync(filePath, "utf8");
  const sanitized = original.replaceAll('"public".', "");
  if (sanitized !== original) {
    writeFileSync(filePath, sanitized);
    console.log(`generate: stripped hardcoded "public". qualifiers from ${file}`);
  }
}

// Sanity check: fail loudly if "public". survived the strip somehow (e.g. a
// future drizzle-kit version formats it differently), rather than silently
// shipping a migration file with the bug still present. Note: patterns like
// "marketing_spend_weeks"."advertising_cost" (a table qualifying its own
// column inside a CHECK constraint) are normal drizzle-kit output and not
// the bug this script targets — only "public". specifically is checked for.
for (const file of newFiles) {
  const filePath = path.join(drizzleDir, file);
  const content = readFileSync(filePath, "utf8");
  if (content.includes('"public".')) {
    console.error(`generate: ${file} still contains "public". after sanitization — review it manually.`);
    process.exit(1);
  }
  void statSync(filePath); // touch, keep import used
}
