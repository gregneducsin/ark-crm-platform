import { Router, type Router as RouterType } from "express";
import { ibluSendWebhookEnvelopeSchema } from "@luma/shared";
import { createIbluSendWebhookAuth } from "../../middleware/webhookAuth.js";
import { handleIbluSendWebhook } from "../../services/iblusend-webhook.service.js";

export function createIbluSendMessageWebhookRouter(): RouterType {
  const router: RouterType = Router();
  const auth = createIbluSendWebhookAuth("IBLUSEND_WEBHOOK_SECRET");

  router.post("/", auth, async (req, res, next) => {
    try {
      const parsed = ibluSendWebhookEnvelopeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid payload.", details: parsed.error.issues });
        return;
      }
      const result = await handleIbluSendWebhook(parsed.data);
      res.status(200).json({ ok: true, duplicate: result.duplicate });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
