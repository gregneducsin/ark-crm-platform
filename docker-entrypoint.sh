#!/bin/sh
# Migrations (and bootstrap-admin seeding) run as a discrete step before the
# API starts serving traffic — never opportunistically per-request. Both are
# advisory-lock guarded and idempotent, so this is safe to run on every
# container start, including when multiple instances boot concurrently.
set -e

echo "entrypoint: running migrations..."
packages/db/node_modules/.bin/tsx packages/db/src/migrate.ts

echo "entrypoint: seeding bootstrap admins..."
packages/db/node_modules/.bin/tsx packages/db/src/seed.ts

echo "entrypoint: starting API server..."
exec node --enable-source-maps apps/api/dist/index.mjs
