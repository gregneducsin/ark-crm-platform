import { Router, type Router as RouterType } from "express";
import { ghlLeadWebhookRequestSchema } from "@luma/shared";
import { createWebhookAuth } from "../../middleware/webhookAuth.js";
import { handleGhlLeadWebhook } from "../../services/webhooks.service.js";
import { respondToInvalidWebhookPayload } from "../../lib/webhook-validation.js";

export function createGhlLeadWebhookRouter(): RouterType {
  const router: RouterType = Router();
  const auth = createWebhookAuth("GHL_WEBHOOK_SECRET");

  router.post("/", auth, async (req, res, next) => {
    try {
      const parsed = ghlLeadWebhookRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        await respondToInvalidWebhookPayload("ghl_lead", req, res, parsed.error);
        return;
      }
      const result = await handleGhlLeadWebhook(parsed.data);
      res.status(200).json({ ok: true, duplicate: result.duplicate });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
