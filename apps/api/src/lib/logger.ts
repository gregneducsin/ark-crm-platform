import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Redaction convention established now, before there's any messaging/PHI
 * content to leak — see ARCHITECTURE.md's "forward compatibility" section.
 * Applies at any key matching these names, wherever they appear in a logged
 * object. Beyond this list, the working convention throughout the codebase
 * is: never pass raw password/token/email/phone values as log fields at
 * all — log ids, counts, and booleans instead.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "password",
      "newPassword",
      "token",
      "rawToken",
      "email",
      "phone",
      "body",
      "message",
      "*.password",
      "*.newPassword",
      "*.token",
      "*.rawToken",
      "*.email",
      "*.phone",
      "*.body",
      "*.message",
    ],
    censor: "[redacted]",
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
