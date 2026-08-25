import pinoHttp from "pino-http";
import { logger } from "../lib/logger.js";

/**
 * Only method/URL-path/status are logged per request — no headers, no body.
 * Query strings are stripped too, since a future messaging/customer-search
 * endpoint could easily put an email or phone number in a query string.
 */
export const requestLogger = pinoHttp({
  logger,
  serializers: {
    req(req) {
      return {
        id: req.id,
        method: req.method,
        url: req.url?.split("?")[0],
      };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
});
