import { Router, type Router as RouterType } from "express";
import type { WebhookEvent } from "@luma/db";
import * as webhookEventsService from "../services/webhook-events.service.js";
import { requireRole } from "../middleware/requireAuth.js";

const STATUS_VALUES = new Set(["received", "processed", "failed", "all"]);
const SOURCE_VALUES = new Set<WebhookEvent["source"]>([
  "ghl_lead",
  "bask_order",
  "bask_questionnaire",
  "bask_payment_failed",
  "bask_payment_succeeded",
  "bask_payment_refunded",
  "bask_prescription_written",
  "bask_order_shipped",
  "iblusend_message",
  "email_inbound",
]);

/** Admin/manager-only, same role gate as Failed Payments — this is technical/integration data, not a customer-service triage queue. */
export function createWebhookEventsRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/", requireRole("admin", "manager"), async (req, res, next) => {
    try {
      const status = typeof req.query.status === "string" && STATUS_VALUES.has(req.query.status) ? (req.query.status as "received" | "processed" | "failed" | "all") : "all";
      const source = typeof req.query.source === "string" && SOURCE_VALUES.has(req.query.source as WebhookEvent["source"]) ? (req.query.source as WebhookEvent["source"]) : undefined;
      const items = await webhookEventsService.listWebhookEvents({ status, source });
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
