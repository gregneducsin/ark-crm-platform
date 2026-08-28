import { Router, type Router as RouterType } from "express";
import { baskPaymentSucceededWebhookRequestSchema } from "@luma/shared";
import { createWebhookAuth } from "../../middleware/webhookAuth.js";
import { handleBaskPaymentSucceededWebhook } from "../../services/webhooks.service.js";

export function createBaskPaymentSucceededWebhookRouter(): RouterType {
  const router: RouterType = Router();
  const auth = createWebhookAuth("PAYMENT_SUCCEEDED_WEBHOOK_SECRET");

  router.post("/", auth, async (req, res, next) => {
    try {
      const parsed = baskPaymentSucceededWebhookRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid payload.", details: parsed.error.issues });
        return;
      }
      const result = await handleBaskPaymentSucceededWebhook(parsed.data);
      res.status(200).json({ ok: true, duplicate: result.duplicate });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
