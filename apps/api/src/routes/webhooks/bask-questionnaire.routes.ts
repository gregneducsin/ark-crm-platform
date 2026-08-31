import { Router, type Router as RouterType } from "express";
import { baskQuestionnaireWebhookRequestSchema } from "@luma/shared";
import { createWebhookAuth } from "../../middleware/webhookAuth.js";
import { handleBaskQuestionnaireWebhook } from "../../services/webhooks.service.js";
import { respondToInvalidWebhookPayload } from "../../lib/webhook-validation.js";

export function createBaskQuestionnaireWebhookRouter(): RouterType {
  const router: RouterType = Router();
  const auth = createWebhookAuth("QUESTIONNAIRE_WEBHOOK_SECRET");

  router.post("/", auth, async (req, res, next) => {
    try {
      const parsed = baskQuestionnaireWebhookRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        await respondToInvalidWebhookPayload("bask_questionnaire", req, res, parsed.error);
        return;
      }
      const result = await handleBaskQuestionnaireWebhook(parsed.data);
      res.status(200).json({ ok: true, duplicate: result.duplicate });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
