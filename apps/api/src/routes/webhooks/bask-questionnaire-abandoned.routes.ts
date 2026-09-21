import { Router, type Router as RouterType, json } from "express";
import { baskQuestionnaireAbandonedWebhookRequestSchema } from "@luma/shared";
import { createWebhookAuth } from "../../middleware/webhookAuth.js";
import { handleBaskQuestionnaireAbandonedWebhook } from "../../services/webhooks.service.js";
import { respondToInvalidWebhookPayload } from "../../lib/webhook-validation.js";
import { unwrapBaskEnvelope } from "../../lib/bask-webhook-envelope.js";

export function createBaskQuestionnaireAbandonedWebhookRouter(): RouterType {
  const router: RouterType = Router();
  // Same secret as the regular questionnaire webhook — same Bask
  // integration, just a different event in its lifecycle.
  const auth = createWebhookAuth("QUESTIONNAIRE_WEBHOOK_SECRET");

  // Confirmed against real Luma deliveries: Bask's own webhook dashboard
  // (this is configured directly from Bask, not through Zapier like the
  // other Bask webhooks) doesn't reliably send Content-Type:
  // application/json — the app-level express.json() middleware only
  // parses when that header matches, so req.body came back undefined every
  // time and every delivery failed validation before ever reaching the
  // fields themselves. This second, permissive json() parser accepts the
  // body as JSON regardless of what Content-Type (if any) actually arrives
  // — safe here because this route is already gated by the shared-secret
  // header, not by Content-Type sniffing.
  const parseJsonRegardlessOfContentType = json({ type: () => true });

  router.post("/", auth, parseJsonRegardlessOfContentType, async (req, res, next) => {
    try {
      const parsed = baskQuestionnaireAbandonedWebhookRequestSchema.safeParse(unwrapBaskEnvelope(req.body));
      if (!parsed.success) {
        // "bask_questionnaire", not a distinct source — see
        // handleBaskQuestionnaireAbandonedWebhook's docstring for why this
        // event doesn't get its own webhook_events source.
        await respondToInvalidWebhookPayload("bask_questionnaire", req, res, parsed.error);
        return;
      }
      const result = await handleBaskQuestionnaireAbandonedWebhook(parsed.data);
      res.status(200).json({ ok: true, duplicate: result.duplicate });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
