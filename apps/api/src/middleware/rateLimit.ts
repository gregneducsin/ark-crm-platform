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

export function createGeneralLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
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
