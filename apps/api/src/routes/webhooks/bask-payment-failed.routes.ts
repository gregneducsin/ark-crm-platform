import { Router, type Router as RouterType, json } from "express";
import { baskPaymentFailedWebhookRequestSchema } from "@luma/shared";
import { createWebhookAuth } from "../../middleware/webhookAuth.js";
import { handleBaskPaymentFailedWebhook } from "../../services/webhooks.service.js";
import { respondToInvalidWebhookPayload } from "../../lib/webhook-validation.js";
import { unwrapBaskEnvelope } from "../../lib/bask-webhook-envelope.js";

export function createBaskPaymentFailedWebhookRouter(): RouterType {
  const router: RouterType = Router();
  const auth = createWebhookAuth("FAILED_PAYMENT_WEBHOOK_SECRET");

  // See bask-questionnaire-abandoned.routes.ts — this route is also meant
  // to be configurable to POST directly from Bask, not only through
  // Zapier, and Bask's own dashboard doesn't reliably send
  // Content-Type: application/json.
  const parseJsonRegardlessOfContentType = json({ type: () => true });

  router.post("/", auth, parseJsonRegardlessOfContentType, async (req, res, next) => {
    try {
      const parsed = baskPaymentFailedWebhookRequestSchema.safeParse(unwrapBaskEnvelope(req.body));
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
