import { Router, type Router as RouterType } from "express";
import { baskPaymentRefundedWebhookRequestSchema } from "@luma/shared";
import { createWebhookAuth } from "../../middleware/webhookAuth.js";
import { handleBaskPaymentRefundedWebhook } from "../../services/webhooks.service.js";
import { respondToInvalidWebhookPayload } from "../../lib/webhook-validation.js";

export function createBaskPaymentRefundedWebhookRouter(): RouterType {
  const router: RouterType = Router();
  const auth = createWebhookAuth("REFUND_WEBHOOK_SECRET");

  router.post("/", auth, async (req, res, next) => {
    try {
      const parsed = baskPaymentRefundedWebhookRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        await respondToInvalidWebhookPayload("bask_payment_refunded", req, res, parsed.error);
        return;
      }
      const result = await handleBaskPaymentRefundedWebhook(parsed.data);
      res.status(200).json({ ok: true, duplicate: result.duplicate });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
