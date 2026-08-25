import { Router, type Router as RouterType } from "express";
import { sendUnmatchedSmsReplyRequestSchema } from "@luma/shared";
import * as unmatchedSmsService from "../services/unmatched-inbound-sms.service.js";
import { requireRole } from "../middleware/requireAuth.js";
import { requireCsrf } from "../middleware/csrf.js";

export function createUnmatchedSmsRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/", requireRole("admin", "customer_service"), async (_req, res, next) => {
    try {
      const items = await unmatchedSmsService.listUnmatchedSmsThreads();
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", requireRole("admin", "customer_service"), async (req, res, next) => {
    try {
      const detail = await unmatchedSmsService.getUnmatchedSmsThreadDetail(req.params.id as string);
      if (!detail) {
        res.status(404).json({ error: "Not found." });
        return;
      }
      res.json({ ...detail.thread, messages: detail.messages });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/reply", requireRole("admin", "customer_service"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = sendUnmatchedSmsReplyRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid payload.", details: parsed.error.issues });
        return;
      }
      const result = await unmatchedSmsService.sendUnmatchedInboundSmsReply(req.params.id as string, parsed.data.body);
      if (!result.sent && result.reason === "not_found") {
        res.status(404).json({ error: "Not found." });
        return;
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/dismiss", requireRole("admin", "customer_service"), requireCsrf, async (req, res, next) => {
    try {
      const ok = await unmatchedSmsService.dismissUnmatchedSmsThread(req.params.id as string);
      if (!ok) {
        res.status(404).json({ error: "Not found." });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
