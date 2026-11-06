import { Router, type Router as RouterType } from "express";
import { requireRole } from "../middleware/requireAuth.js";
import { requireCsrf } from "../middleware/csrf.js";
import {
  campaignAudience,
  createCampaign,
  listCampaigns,
  setCampaignStatus,
  testCampaign,
  saveCampaignSchedule,
} from "../services/email-campaigns.service.js";
export function createEmailCampaignsRouter(): RouterType {
  const router = Router();
  router.use(requireRole("admin"));
  router.get("/", async (_req, res, next) => {
    try {
      res.json({
        campaigns: await listCampaigns(),
        eligible: (await campaignAudience()).length,
      });
    } catch (e) {
      next(e);
    }
  });
  router.post("/", requireCsrf, async (req, res, next) => {
    try {
      res.json(await createCampaign(req.user!.email));
    } catch (e) {
      next(e);
    }
  });
  router.post("/:id/:action", requireCsrf, async (req, res, next) => {
    try {
      const id = String(req.params.id),
        action = String(req.params.action);
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        res.status(400).json({ error: "Invalid campaign" });
        return;
      }
      if (action === "test") {
        res.json(await testCampaign(id));
        return;
      }
      if (action === "schedule") {
        try { res.json(await saveCampaignSchedule(id,req.body?.schedule)); }
        catch(e) { res.status(400).json({error:e instanceof Error?e.message:'Invalid schedule'}); }
        return;
      }
      if (action !== "start" && action !== "pause") {
        res.status(400).json({ error: "Invalid action" });
        return;
      }
      res.json(
        await setCampaignStatus(
          id,
          action,
          req.body?.perHour,
          req.body?.approved === true,
        ),
      );
    } catch (e) {
      next(e);
    }
  });
  return router;
}

