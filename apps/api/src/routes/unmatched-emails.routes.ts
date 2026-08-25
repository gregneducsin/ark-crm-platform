import { Router, type Router as RouterType } from "express";
import { sendUnmatchedEmailReplyRequestSchema } from "@luma/shared";
import * as unmatchedEmailsService from "../services/unmatched-inbound-email.service.js";
import { requireRole } from "../middleware/requireAuth.js";
import { requireCsrf } from "../middleware/csrf.js";

export function createUnmatchedEmailsRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/", requireRole("admin", "customer_service"), async (_req, res, next) => {
    try {
      const items = await unmatchedEmailsService.listUnmatchedEmailThreads();
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", requireRole("admin", "customer_service"), async (req, res, next) => {
    try {
      const detail = await unmatchedEmailsService.getUnmatchedEmailThreadDetail(req.params.id as string);
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
      const parsed = sendUnmatchedEmailReplyRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid payload.", details: parsed.error.issues });
        return;
      }
      const result = await unmatchedEmailsService.sendUnmatchedInboundEmailReply(req.params.id as string, parsed.data.body);
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
      const ok = await unmatchedEmailsService.dismissUnmatchedEmailThread(req.params.id as string);
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
