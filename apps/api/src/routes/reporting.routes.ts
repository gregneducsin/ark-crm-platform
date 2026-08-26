import { Router, type Router as RouterType } from "express";
import { dateRangeQuerySchema } from "@luma/shared";
import { getFunnelSummary, getMessageVolumeByChannel, getResponseTimeStats } from "../services/reporting.service.js";
import { requireRole } from "../middleware/requireAuth.js";

export function createReportingRouter(): RouterType {
  const router: RouterType = Router();

  // admin + manager, matching /api/app/customers' own role gate — this
  // endpoint is what the dashboard's top-line Leads/Revenue figures and
  // funnel breakdown are sourced from, same audience as the Leads/Orders
  // tab those figures used to come from.
  router.get("/funnel", requireRole("admin", "manager"), async (req, res, next) => {
    try {
      const parsed = dateRangeQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid query.", details: parsed.error.issues });
        return;
      }
      const range = parsed.data.from && parsed.data.to ? { from: parsed.data.from, to: parsed.data.to } : undefined;
      const funnel = await getFunnelSummary(range);
      res.json(funnel);
    } catch (err) {
      next(err);
    }
  });

  router.get("/messages", requireRole("admin"), async (_req, res, next) => {
    try {
      const [volume, responseTimes] = await Promise.all([getMessageVolumeByChannel(), getResponseTimeStats()]);
      res.json({ volume, responseTimes });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
