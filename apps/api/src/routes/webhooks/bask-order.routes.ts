import { Router, type Router as RouterType, json } from "express";
import { baskOrderWebhookRequestSchema } from "@luma/shared";
import { createWebhookAuth } from "../../middleware/webhookAuth.js";
import { handleBaskOrderWebhook } from "../../services/webhooks.service.js";
import { respondToInvalidWebhookPayload } from "../../lib/webhook-validation.js";
import { unwrapBaskEnvelope } from "../../lib/bask-webhook-envelope.js";

export function createBaskOrderWebhookRouter(): RouterType {
  const router: RouterType = Router();
  const auth = createWebhookAuth("ORDER_WEBHOOK_SECRET");

  // See bask-questionnaire-abandoned.routes.ts — this route is also meant
  // to be configurable to POST directly from Bask, not only through
  // Zapier, and Bask's own dashboard doesn't reliably send
  // Content-Type: application/json.
  const parseJsonRegardlessOfContentType = json({ type: () => true });

  router.post("/", auth, parseJsonRegardlessOfContentType, async (req, res, next) => {
    try {
      const parsed = baskOrderWebhookRequestSchema.safeParse(unwrapBaskEnvelope(req.body));
      if (!parsed.success) {
        await respondToInvalidWebhookPayload("bask_order", req, res, parsed.error);
        return;
      }
      const result = await handleBaskOrderWebhook(parsed.data);
      res.status(200).json({ ok: true, duplicate: result.duplicate });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
