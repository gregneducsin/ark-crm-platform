import { Router, type Router as RouterType } from "express";
import { baskQuestionnaireNewPatientWebhookRequestSchema } from "@luma/shared";
import { createWebhookAuth } from "../../middleware/webhookAuth.js";
import { handleBaskQuestionnaireNewPatientWebhook } from "../../services/webhooks.service.js";
import { respondToInvalidWebhookPayload } from "../../lib/webhook-validation.js";

export function createBaskQuestionnaireNewPatientWebhookRouter(): RouterType {
  const router: RouterType = Router();
  // Same secret as the regular questionnaire webhook — same Bask/Zapier
  // integration, just an earlier event in its lifecycle.
  const auth = createWebhookAuth("QUESTIONNAIRE_WEBHOOK_SECRET");

  router.post("/", auth, async (req, res, next) => {
    try {
      const parsed = baskQuestionnaireNewPatientWebhookRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        // "bask_questionnaire", not a distinct source — see
        // handleBaskQuestionnaireNewPatientWebhook's docstring for why this
        // event doesn't get its own webhook_events source.
        await respondToInvalidWebhookPayload("bask_questionnaire", req, res, parsed.error);
        return;
      }
      const result = await handleBaskQuestionnaireNewPatientWebhook(parsed.data);
      res.status(200).json({ ok: true, duplicate: result.duplicate });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
