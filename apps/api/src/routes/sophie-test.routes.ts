import { Router, type Router as RouterType } from "express";
import { sendSophieTestMessageRequestSchema } from "@luma/shared";
import { processInboundSupportMessage } from "../services/sophie-dispatch.service.js";
import * as customersService from "../services/customers.service.js";
import { requireRole } from "../middleware/requireAuth.js";
import { requireCsrf } from "../middleware/csrf.js";
import { createSophieTestLimiter } from "../middleware/rateLimit.js";

/**
 * Internal test surface for Sophie's support conversation loop — same
 * reasoning as alexis-test.routes.ts: lets staff simulate an inbound patient
 * text and run it through the real pipeline without needing an actual SMS
 * provider yet.
 */
export function createSophieTestRouter(): RouterType {
  const router: RouterType = Router();
  const limiter = createSophieTestLimiter();

  router.post("/message", limiter, requireRole("admin", "customer_service"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = sendSophieTestMessageRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }

      const customer = await customersService.getCustomer(parsed.data.customerId);
      if (!customer) {
        res.status(404).json({ error: "Customer not found." });
        return;
      }

      const result = await processInboundSupportMessage(customer.id, parsed.data.message);

      if (!result.ok && result.code === "PROVIDER_NOT_CONFIGURED") {
        res.status(503).json({ error: "Sophie's conversation loop isn't configured yet." });
        return;
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
