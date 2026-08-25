import { Router, type Router as RouterType } from "express";
import { baskPrescriptionWrittenWebhookRequestSchema } from "@luma/shared";
import { createWebhookAuth } from "../../middleware/webhookAuth.js";
import { handleBaskPrescriptionWrittenWebhook } from "../../services/webhooks.service.js";

export function createBaskPrescriptionWrittenWebhookRouter(): RouterType {
  const router: RouterType = Router();
  const auth = createWebhookAuth("PRESCRIPTION_WRITTEN_WEBHOOK_SECRET");

  router.post("/", auth, async (req, res, next) => {
    try {
      const parsed = baskPrescriptionWrittenWebhookRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid payload.", details: parsed.error.issues });
        return;
      }
      const result = await handleBaskPrescriptionWrittenWebhook(parsed.data);
      res.status(200).json({ ok: true, duplicate: result.duplicate });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
