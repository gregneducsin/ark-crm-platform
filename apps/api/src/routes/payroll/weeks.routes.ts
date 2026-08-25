import { Router, type Router as RouterType } from "express";
import { createPayrollWeekRequestSchema, upsertWeeklyHoursRequestSchema, createBonusRequestSchema } from "@luma/shared";
import * as payrollWeeksService from "../../services/payroll-weeks.service.js";
import { requireRole } from "../../middleware/requireAuth.js";
import { requireCsrf } from "../../middleware/csrf.js";

export function createPayrollWeeksRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/", requireRole("admin", "manager"), async (_req, res, next) => {
    try {
      res.json({ weeks: await payrollWeeksService.listPayrollWeeks() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", requireRole("admin", "manager"), async (req, res, next) => {
    try {
      const detail = await payrollWeeksService.getPayrollWeekDetail(req.params.id as string);
      if (!detail) {
        res.status(404).json({ error: "Payroll week not found." });
        return;
      }
      res.json(detail);
    } catch (err) {
      next(err);
    }
  });

  router.post("/", requireRole("admin", "manager"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = createPayrollWeekRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }
      const week = await payrollWeeksService.createPayrollWeek(parsed.data);
      res.status(201).json({ week });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/approve", requireRole("admin", "manager"), requireCsrf, async (req, res, next) => {
    try {
      const result = await payrollWeeksService.approvePayrollWeek(req.params.id as string, req.user!);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ week: result.week });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/pay", requireRole("admin", "manager"), requireCsrf, async (req, res, next) => {
    try {
      const result = await payrollWeeksService.payPayrollWeek(req.params.id as string, req.user!);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ week: result.week });
    } catch (err) {
      next(err);
    }
  });

  router.put("/:id/hours", requireRole("admin", "manager"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = upsertWeeklyHoursRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }
      const result = await payrollWeeksService.upsertWeeklyHours(req.params.id as string, parsed.data, req.user!);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ entry: result.entry });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/bonuses", requireRole("admin", "manager"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = createBonusRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }
      const result = await payrollWeeksService.createBonus(req.params.id as string, parsed.data, req.user!);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.status(201).json({ bonus: result.bonus });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
