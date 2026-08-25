import { Router, type Router as RouterType } from "express";
import { baskOrderShippedWebhookRequestSchema } from "@luma/shared";
import { createWebhookAuth } from "../../middleware/webhookAuth.js";
import { handleBaskOrderShippedWebhook } from "../../services/webhooks.service.js";

export function createBaskOrderShippedWebhookRouter(): RouterType {
  const router: RouterType = Router();
  const auth = createWebhookAuth("ORDER_SHIPPED_WEBHOOK_SECRET");

  router.post("/", auth, async (req, res, next) => {
    try {
      const parsed = baskOrderShippedWebhookRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid payload.", details: parsed.error.issues });
        return;
      }
      const result = await handleBaskOrderShippedWebhook(parsed.data);
      res.status(200).json({ ok: true, duplicate: result.duplicate });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
