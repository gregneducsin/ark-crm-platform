/**
 * Startup env validation. Fails loudly and immediately rather than letting
 * a missing var surface as a confusing runtime error later.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required but was not provided.`);
  }
  return value;
}

const rawPort = required("PORT");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const nodeEnv = process.env.NODE_ENV ?? "development";

// No default in production — an empty allowlist plus cors' reflect-nothing
// behavior means every cross-origin browser request is rejected until this
// is set, which is the safe failure direction. Development defaults to the
// dashboard dev server's own origin so local development works out of the box.
const corsAllowedOrigins = (
  process.env.CORS_ALLOWED_ORIGINS ?? (nodeEnv === "production" ? "" : "http://localhost:5173")
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export const env = {
  port,
  nodeEnv,
  isProduction: nodeEnv === "production",
  logLevel: process.env.LOG_LEVEL ?? "info",
  corsAllowedOrigins,
};
