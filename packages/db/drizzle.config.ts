import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
}

// Relative, not absolute — drizzle-kit's own path-joining when diffing
// against an existing snapshot mishandles an absolute `out`, producing a
// malformed doubled path ("./" + "/abs/path") and failing to find the prior
// snapshot at all. generate.mjs always invokes drizzle-kit with cwd set to
// this package's root, so relative paths resolve correctly either way.
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
