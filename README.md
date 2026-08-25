# Ark Health Platform

Internal tool for tracking customers/leads, purchases, and payroll. Rebuilt clean
(no Replit dependency) from an earlier prototype; see [ARCHITECTURE.md](./ARCHITECTURE.md)
for the reasoning behind key decisions.

AI-guardrailed texting is live: Alexis (sales/lead outreach) and Sophie
(post-purchase support) draft replies that are safety-checked against an
approved knowledge catalog before sending, and hand off to staff for
anything requiring individualized clinical judgment. See
[STAFF_TEXTING_GUIDE.md](./STAFF_TEXTING_GUIDE.md) for what staff should and
shouldn't say when picking up one of those handoffs. No SMS provider is
wired up yet, so inbound messages currently arrive via the bot-preview/test
tool rather than a real phone number — see "Forward compatibility" in
ARCHITECTURE.md for what's already in place ahead of that.

## Stack

- **API**: Express 5, TypeScript, Drizzle ORM, Postgres 16
- **Dashboard**: React 19, Vite 7, TanStack Query, Wouter, Tailwind CSS
- **Auth**: email/password (argon2), Postgres-backed opaque session tokens — no OIDC
- **Validation**: Zod, hand-written and shared between API and dashboard (`packages/shared`)
- **Package manager**: pnpm workspaces

## Local development

Requires Node 22+, pnpm 10.26.1 (`corepack enable && corepack prepare pnpm@10.26.1 --activate`),
and a running Postgres 16 instance.

```bash
# 1. Install dependencies
pnpm install

# 2. Start Postgres (or point DATABASE_URL at your own instance)
docker compose up -d db

# 3. Configure environment
cp .env.example .env
# edit .env — at minimum, DATABASE_URL must be reachable

# 4. Run migrations, then seed a bootstrap admin
pnpm db:migrate
BOOTSTRAP_ADMIN_EMAILS=you@example.com pnpm db:seed

# 5. Start the API and dashboard (separate terminals)
pnpm dev:api
pnpm dev:web
```

The dashboard dev server runs at `http://localhost:5173` and proxies `/api/*`
to the API server. To finish activating the bootstrap admin, use the
invitation-link flow surfaced in the API logs on first seed.

## Commands

| Command | What it does |
|---|---|
| `pnpm typecheck` | Typecheck every package |
| `pnpm build` | Typecheck, then build every package |
| `pnpm test` | Run all test suites (requires `DATABASE_URL` pointed at a disposable Postgres instance — **never point this at a production database**) |
| `pnpm db:migrate` | Apply pending migrations (advisory-lock guarded, safe to run concurrently) |
| `pnpm db:generate` | Generate a new migration file from schema changes in `packages/db/src/schema/` |
| `pnpm db:seed` | Seed bootstrap admin(s) from `BOOTSTRAP_ADMIN_EMAILS` (idempotent) |

**Never run `drizzle-kit push` against a shared or production database** — it's
a prototyping tool that diffs and applies live schema changes with no
reviewable migration file. Always use `db:generate` + `db:migrate`.

## Repository layout

```
apps/
  api/       Express API — deploys as a container
  web/       React dashboard — deploys as a static build
packages/
  db/        Drizzle schema, migrations, migrate.ts, seed.ts
  shared/    Hand-written Zod schemas + types shared between api and web
```

## Docker

```bash
docker compose up          # Postgres + API + dashboard, full local stack
docker compose up -d db    # just Postgres, for running apps natively
```

`Dockerfile.api` and `Dockerfile.web` each build one deployable image
(separate files, not one multi-stage Dockerfile with a `target`, so hosts
that can't select a build target — e.g. Railway — still work). The web
image's nginx config proxies `/api/*` to the API service; which hostname
that is comes from the `API_UPSTREAM` env var at container start (see
`nginx.conf.template`) — docker-compose sets it to `api:3001`, other hosts
set it to whatever they call the API service internally.
