import { Router, type Router as RouterType } from "express";
import { ibluSendWebhookEnvelopeSchema } from "@luma/shared";
import { createIbluSendWebhookAuth } from "../../middleware/webhookAuth.js";
import { handleIbluSendWebhook } from "../../services/iblusend-webhook.service.js";
import { respondToInvalidWebhookPayload } from "../../lib/webhook-validation.js";

export function createIbluSendMessageWebhookRouter(): RouterType {
  const router: RouterType = Router();
  const inboundAuth = createIbluSendWebhookAuth("IBLUSEND_WEBHOOK_SECRET");
  const deliveryAuth = createIbluSendWebhookAuth("IBLUSEND_DELIVERY_WEBHOOK_SECRET");
  const deliveryEvents = new Set(["message.sent", "message.delivered", "message.read", "message.failed"]);

  router.post("/", (req, res, next) => {
    // A separate delivery subscription has its own signing key. Restrict it
    // to receipts so it cannot authenticate incoming customer messages.
    if (process.env.IBLUSEND_DELIVERY_WEBHOOK_SECRET && deliveryEvents.has(req.body?.event)) {
      deliveryAuth(req, res, next);
    } else {
      inboundAuth(req, res, next);
    }
  }, async (req, res, next) => {
    try {
      const parsed = ibluSendWebhookEnvelopeSchema.safeParse(req.body);
      if (!parsed.success) {
        await respondToInvalidWebhookPayload("iblusend_message", req, res, parsed.error);
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
