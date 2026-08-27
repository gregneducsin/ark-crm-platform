import { Router, type Router as RouterType } from "express";
import { resolveFailedPaymentRequestSchema } from "@luma/shared";
import * as failedPaymentsService from "../services/failed-payments.service.js";
import { requireRole } from "../middleware/requireAuth.js";
import { requireCsrf } from "../middleware/csrf.js";

const STATUS_VALUES = new Set(["open", "resolved", "all"]);

/** Admin/manager-only, same role gate as Orders — this is financial/business data, not a customer-service triage queue. */
export function createFailedPaymentsRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/", requireRole("admin", "manager"), async (req, res, next) => {
    try {
      const status = typeof req.query.status === "string" && STATUS_VALUES.has(req.query.status) ? (req.query.status as "open" | "resolved" | "all") : "open";
      const items = await failedPaymentsService.listFailedPayments(status);
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/resolve", requireRole("admin", "manager"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = resolveFailedPaymentRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }
      const result = await failedPaymentsService.resolveFailedPayment(req.params.id as string, parsed.data.notes);
      if (!result.ok) {
        res.status(404).json({ error: "Failed payment not found." });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/reopen", requireRole("admin", "manager"), requireCsrf, async (req, res, next) => {
    try {
      const result = await failedPaymentsService.reopenFailedPayment(req.params.id as string);
      if (!result.ok) {
        res.status(404).json({ error: "Failed payment not found, or it isn't currently resolved." });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
