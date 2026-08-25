import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger.js";

interface HttpError extends Error {
  statusCode?: number;
  status?: number;
  detail?: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: HttpError, _req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err }, "unhandled route error");
  const status = err.statusCode ?? err.status ?? 500;
  res.status(status).json({
    error: err.message ?? "Internal server error",
    detail: err.detail,
  });
}
