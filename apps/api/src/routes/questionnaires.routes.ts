import { Router, type Router as RouterType } from "express";
import { questionnairesQuerySchema } from "@luma/shared";
import * as questionnairesService from "../services/questionnaires.service.js";
import { requireRole } from "../middleware/requireAuth.js";

export function createQuestionnairesRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/", requireRole("admin"), async (req, res, next) => {
    try {
      const parsed = questionnairesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid query.", details: parsed.error.issues });
        return;
      }
      const data = await questionnairesService.getQuestionnairesData(parsed.data);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
