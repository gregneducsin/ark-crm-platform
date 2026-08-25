import { Router, type Router as RouterType } from "express";
import { updatePurchaseRequestSchema, listPurchasesQuerySchema, purchasesSummaryQuerySchema } from "@luma/shared";
import * as purchasesService from "../services/purchases.service.js";
import { requireRole } from "../middleware/requireAuth.js";
import { requireCsrf } from "../middleware/csrf.js";

export function createPurchasesRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/", requireRole("admin", "manager"), async (req, res, next) => {
    try {
      const parsed = listPurchasesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid query.", details: parsed.error.issues });
        return;
      }
      const result = await purchasesService.listPurchases(parsed.data);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/summary", requireRole("admin", "manager"), async (req, res, next) => {
    try {
      const parsed = purchasesSummaryQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid query.", details: parsed.error.issues });
        return;
      }
      const summary = await purchasesService.getPurchasesSummary(parsed.data);
      res.json(summary);
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id", requireRole("admin"), requireCsrf, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        res.status(400).json({ error: "Invalid purchase id." });
        return;
      }
      const parsed = updatePurchaseRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }
      // req.user is guaranteed non-null by requireRole above.
      const purchase = await purchasesService.updatePurchase(id, parsed.data, req.user!);
      if (!purchase) {
        res.status(404).json({ error: "Purchase not found." });
        return;
      }
      res.json({ purchase });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
