import { Router, type Router as RouterType } from "express";
import { sendUnifiedConversationReplyRequestSchema } from "@luma/shared";
import * as unifiedConversationsService from "../services/unified-conversations.service.js";
import { requireRole } from "../middleware/requireAuth.js";
import { requireCsrf } from "../middleware/csrf.js";

export function createUnifiedConversationsRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/", requireRole("admin", "customer_service"), async (_req, res, next) => {
    try {
      const [conversations, salesStats] = await Promise.all([
        unifiedConversationsService.listUnifiedConversationSummaries(),
        unifiedConversationsService.getSalesResponseStats(),
      ]);
      res.json({ conversations, salesStats });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:personId", requireRole("admin", "customer_service"), async (req, res, next) => {
    try {
      const detail = await unifiedConversationsService.getUnifiedConversationDetail(req.params.personId as string);
      if (!detail) {
        res.status(404).json({ error: "No conversation found for this person." });
        return;
      }
      res.json(detail);
    } catch (err) {
      next(err);
    }
  });

  router.post("/:personId/clear-attention", requireRole("admin", "customer_service"), requireCsrf, async (req, res, next) => {
    try {
      await unifiedConversationsService.clearAllNeedsAttention(req.params.personId as string);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:personId/reply", requireRole("admin", "customer_service"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = sendUnifiedConversationReplyRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid payload.", details: parsed.error.issues });
        return;
      }
      const result = await unifiedConversationsService.sendUnifiedStaffReply(
        req.params.personId as string,
        parsed.data.persona,
        parsed.data.channel,
        parsed.data.body,
        req.user!.email,
      );
      if (!result.sent && result.reason === "not_found") {
        res.status(404).json({ error: "No conversation on that pipeline for this person." });
        return;
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
