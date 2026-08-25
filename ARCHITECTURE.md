# Architecture decisions

This is a clean rebuild of an earlier Replit-hosted prototype. The prototype's
domain model and stack were sound (proven schema, working auth, hundreds of
passing tests) but it was tightly coupled to Replit and had accumulated some
fixable issues. Rather than untangle that in place, this repo starts fresh
with the same domain model, one auth system instead of two, one migration
mechanism instead of two, and correct infra/docs from day one.

## What's deliberately different from the prototype

- **One auth system**: email/password with argon2 only. No OIDC, no legacy
  bridge, no external identity provider dependency.
- **One migration mechanism**: `drizzle-kit generate` produces reviewable SQL
  files; `packages/db/src/migrate.ts` applies them via drizzle's own tracked
  migrator, guarded by a Postgres advisory lock for safe concurrent-instance
  boot. There is no second, hand-written schema definition anywhere — the
  prototype had two mechanisms that silently drifted out of sync, which is
  exactly the failure mode this avoids.
- **No OpenAPI/codegen pipeline**: Zod schemas are hand-written once in
  `packages/shared` and imported directly by both the API (route validation)
  and the dashboard (form validation, response types). For one API and one
  internal SPA maintained by the same team, generated-client codegen was
  overhead without enough payoff. If an external integration ever needs a
  formal spec, generate OpenAPI *from* these Zod schemas — that's additive,
  not a redesign.
- **Webhook auth uses `crypto.timingSafeEqual`**, not `!==`, comparing
  length-checked buffers so it fails closed on a length mismatch rather than
  throwing.
- **CORS uses an explicit origin allowlist** (`CORS_ALLOWED_ORIGINS`), never
  a reflect-all `origin: true`.
- **Sessions are opaque server-side tokens**: only a SHA-256 hash of the
  session token is ever persisted or logged; the raw token exists only in the
  browser's cookie and the response that set it.
- **CSRF and webhook-secret auth are mounted on physically separate
  routers** (`/api/app/*` vs `/webhooks/*`) rather than one router with
  per-route exemptions — there's no route where the wrong auth mechanism, or
  neither, applies by accident.
- **`engines`/`packageManager` are pinned** in the root `package.json` — the
  prototype had neither, so nothing enforced which Node/pnpm version a
  developer used.

## Forward compatibility for the future texting phase

**Texting is not implemented in this codebase yet, and it is not a small
feature when it lands** — it will be a full AI-assisted messaging system with
consent tracking, opt-out (STOP/HELP) handling, safety-gated AI drafting,
staff review/approval, and an audit trail, not a raw "call an SMS API"
integration. Nothing in that system exists here, but a few conventions were
chosen specifically so it won't require reworking these foundations later:

- `customers.phone` is already in the schema, stored normalized (E.164) —
  the join key the future messaging tables will hang off of.
- `user_audit_events` / `payroll_audit_events` (append-only, actor + action +
  before/after values) are the pattern a future `message_audit_events` table
  should follow exactly — nothing new to design, just add the table.
- The `/webhooks/*` router + `timingSafeEqual` shared-secret middleware is
  directly reusable for a future inbound-SMS-provider webhook — a new route
  file, not a new auth mechanism.
- Structured-log redaction (by key name — `email`, `phone`, `body`, `message`)
  is established now, before there's any PII-bearing message content to leak,
  specifically so it's already in place when messaging code starts producing
  logs.
- Whichever hosting/managed-Postgres provider eventually gets chosen needs to
  be one that can offer a HIPAA BAA before real patient message content flows
  through it — the prototype's Replit hosting could not confirm this.

## Explicitly out of scope right now

- Texting/SMS/AI messaging — separate future phase (see above).
- A specific hosting provider or managed Postgres provider — the code only
  requires a standard `DATABASE_URL` and portable Dockerfiles, so this
  decision can be made independently, later.
