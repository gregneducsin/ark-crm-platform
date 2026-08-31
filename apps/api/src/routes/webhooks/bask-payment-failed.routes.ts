import { Router, type Router as RouterType } from "express";
import { baskPaymentFailedWebhookRequestSchema } from "@luma/shared";
import { createWebhookAuth } from "../../middleware/webhookAuth.js";
import { handleBaskPaymentFailedWebhook } from "../../services/webhooks.service.js";
import { respondToInvalidWebhookPayload } from "../../lib/webhook-validation.js";

export function createBaskPaymentFailedWebhookRouter(): RouterType {
  const router: RouterType = Router();
  const auth = createWebhookAuth("FAILED_PAYMENT_WEBHOOK_SECRET");

  router.post("/", auth, async (req, res, next) => {
    try {
      const parsed = baskPaymentFailedWebhookRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        await respondToInvalidWebhookPayload("bask_payment_failed", req, res, parsed.error);
        return;
      }
      const result = await handleBaskPaymentFailedWebhook(parsed.data);
      res.status(200).json({ ok: true, duplicate: result.duplicate });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
