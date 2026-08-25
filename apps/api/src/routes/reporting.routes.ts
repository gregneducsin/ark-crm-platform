import { Router, type Router as RouterType } from "express";
import { getFunnelSummary, getMessageVolumeByChannel, getResponseTimeStats } from "../services/reporting.service.js";
import { requireRole } from "../middleware/requireAuth.js";

export function createReportingRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/funnel", requireRole("admin"), async (_req, res, next) => {
    try {
      const funnel = await getFunnelSummary();
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
