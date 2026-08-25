import { Router, type Router as RouterType } from "express";
import { createMarketingSpendWeekRequestSchema, updateMarketingSpendWeekRequestSchema } from "@luma/shared";
import * as marketingSpendService from "../../services/marketing-spend.service.js";
import { requireRole } from "../../middleware/requireAuth.js";
import { requireCsrf } from "../../middleware/csrf.js";

export function createMarketingSpendRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/", requireRole("admin"), async (_req, res, next) => {
    try {
      res.json({ weeks: await marketingSpendService.listMarketingCpaWeeks() });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", requireRole("admin"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = createMarketingSpendWeekRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }
      const result = await marketingSpendService.createMarketingSpendWeek(parsed.data, req.user!);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.status(201).json({ week: result.week });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id", requireRole("admin"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = updateMarketingSpendWeekRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }
      const week = await marketingSpendService.updateMarketingSpendWeek(req.params.id as string, parsed.data, req.user!);
      if (!week) {
        res.status(404).json({ error: "Marketing spend week not found." });
        return;
      }
      res.json({ week });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
