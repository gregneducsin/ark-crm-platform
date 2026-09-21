import { Router, type Router as RouterType, json } from "express";
import { baskPaymentRefundedWebhookRequestSchema } from "@luma/shared";
import { createWebhookAuth } from "../../middleware/webhookAuth.js";
import { handleBaskPaymentRefundedWebhook } from "../../services/webhooks.service.js";
import { respondToInvalidWebhookPayload } from "../../lib/webhook-validation.js";
import { unwrapBaskEnvelope } from "../../lib/bask-webhook-envelope.js";

export function createBaskPaymentRefundedWebhookRouter(): RouterType {
  const router: RouterType = Router();
  const auth = createWebhookAuth("REFUND_WEBHOOK_SECRET");

  // See bask-questionnaire-abandoned.routes.ts — this route is also meant
  // to be configurable to POST directly from Bask, not only through
  // Zapier, and Bask's own dashboard doesn't reliably send
  // Content-Type: application/json.
  const parseJsonRegardlessOfContentType = json({ type: () => true });

  router.post("/", auth, parseJsonRegardlessOfContentType, async (req, res, next) => {
    try {
      const unwrapped = unwrapBaskEnvelope(req.body);
      // Bask's own raw field names for this event (owner-supplied, see the
      // schema's docstring) don't match this app's internal flat shape —
      // unlike the other Bask webhooks confirmed so far, which already use
      // matching names. The old Zap did this renaming for us; a direct
      // Bask delivery doesn't, so it happens here instead.
      const candidate =
        unwrapped && typeof unwrapped === "object"
          ? (() => {
              const { patientId, date, paymentMethod, ...rest } = unwrapped as Record<string, unknown>;
              return {
                ...rest,
                ...(patientId !== undefined ? { externalPersonId: patientId } : {}),
                ...(date !== undefined ? { refundDate: date } : {}),
                ...(paymentMethod !== undefined ? { paymentMethodType: paymentMethod } : {}),
              };
            })()
          : unwrapped;
      const parsed = baskPaymentRefundedWebhookRequestSchema.safeParse(candidate);
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
