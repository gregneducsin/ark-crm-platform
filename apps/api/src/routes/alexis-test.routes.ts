import { Router, type Router as RouterType } from "express";
import { sendAlexisTestMessageRequestSchema } from "@luma/shared";
import { processInboundMessage } from "../services/alexis-dispatch.service.js";
import * as customersService from "../services/customers.service.js";
import { requireRole } from "../middleware/requireAuth.js";
import { requireCsrf } from "../middleware/csrf.js";
import { createAlexisTestLimiter } from "../middleware/rateLimit.js";

/**
 * Internal test surface for the Alexis conversation loop — lets staff simulate
 * an inbound customer text and run it through the real pipeline (pre-check,
 * Claude, post-check, persistence, SMS dispatch attempt) without needing an
 * actual SMS provider. Goes through the same persisted-conversation path
 * production inbound webhooks will use once a provider exists, so testing
 * here populates the same conversation log the dashboard shows.
 */
export function createAlexisTestRouter(): RouterType {
  const router: RouterType = Router();
  const limiter = createAlexisTestLimiter();

  router.post("/message", limiter, requireRole("admin", "customer_service"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = sendAlexisTestMessageRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }

      const customer = await customersService.getCustomer(parsed.data.customerId);
      if (!customer) {
        res.status(404).json({ error: "Customer not found." });
        return;
      }

      const result = await processInboundMessage(customer.id, parsed.data.message);

      if (!result.ok && result.code === "PROVIDER_NOT_CONFIGURED") {
        res.status(503).json({ error: "The Alexis conversation loop isn't configured yet." });
        return;
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
