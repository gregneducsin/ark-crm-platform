import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";

/**
 * Factories, not singletons — each createApp() call gets its own limiter
 * instance with independent state. A module-level singleton would mean
 * every call to createApp() (each test in the test suite calls it fresh)
 * shares the same underlying hit-count store, so an early test could
 * exhaust the budget for every test that runs after it in the same process.
 *
 * In-memory, single-instance store (the default) — a deliberate simplicity
 * choice for this phase, see ARCHITECTURE.md. Only correct as long as the
 * API runs as a single instance; revisit with a shared store if/when
 * multi-instance hosting is chosen.
 */
export function createAuthLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts. Please try again later." },
  });
}

/**
 * Keyed by the attempted email, not IP — the limiter above only budgets
 * attempts per source IP, so an attacker spreading login guesses for one
 * known account across many IPs (a botnet, a proxy pool) never trips it at
 * all, no matter how many total attempts land. This closes that gap.
 *
 * Deliberately wider than the per-IP budget (10/15min) — this exists to
 * catch a distributed attack, not to be the everyday lockout mechanism, so
 * it shouldn't trip on a legitimate user who mistypes their password a
 * handful of times from one place (the per-IP limiter above already covers
 * that case tightly). Mounted on /login only — forgot/reset-password and
 * accept-invitation aren't password-guessing surfaces.
 */
export function createAuthAccountLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts. Please try again later." },
    keyGenerator: (req) => (typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "unknown"),
  });
}

export function createGeneralLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    // 300 sounded generous until accounting for what the app itself
    // generates in the background: Layout renders three 15s-interval polls
    // (needs-attention, unmatched emails, unmatched sms) on every page for
    // every staff member who can see them — 12 requests/min from a single
    // idle tab before any manual navigation, and Support's list/detail polls
    // (8s/4s) add far more while open. One active staff member alone can
    // exhaust 300 in under half an hour; a handful of staff sharing one
    // office/VPN IP exhaust it in minutes. Once exhausted, every API call
    // from that IP 429s — including the CSRF-token fetch that gates login,
    // so a saturated shared IP could lock everyone on it out of the app
    // entirely. Raised to a budget sized for real multi-staff polling load,
    // not just a handful of manual clicks.
    limit: 5000,
    standardHeaders: true,
    legacyHeaders: false,
    // Belt-and-suspenders on top of the raised limit above: even if this
    // budget is somehow still exhausted, login must stay reachable — these
    // two are the calls every page load makes before anything else, they're
    // cheap, safe, GET-only, and have no side effects worth limiting.
    skip: (req) => req.path === "/api/app/auth/csrf-token" || req.path === "/api/app/auth/me",
  });
}

// Tighter than the general limiter — each request can run a multi-turn LLM
// tool-use loop, so it's meaningfully more expensive than a normal API call.
export function createAiAssistantLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many assistant requests. Please wait a bit and try again." },
  });
}

// Same reasoning as createAiAssistantLimiter — one LLM call per request.
export function createAlexisTestLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many test turns. Please wait a bit and try again." },
  });
}

// Same reasoning as createAlexisTestLimiter, for Sophie's test surface.
export function createSophieTestLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many test turns. Please wait a bit and try again." },
  });
}
