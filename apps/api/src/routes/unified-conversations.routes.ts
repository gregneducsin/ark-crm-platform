import { z } from "zod";
import { listUnifiedConversationPage, countUnifiedAttention, InvalidConversationCursor } from "../services/conversation-pages.service.js";
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


  // A short-lived shared aggregate cache coalesces concurrent staff polls.
  let stats: { value: { salesStats: unifiedConversationsService.SalesResponseStats; attentionCount: number }; expires: number } | undefined;
  let statsPending: Promise<{ salesStats: unifiedConversationsService.SalesResponseStats; attentionCount: number }> | undefined;
  router.get("/stats", requireRole("admin", "customer_service"), async (_req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      if (stats && stats.expires > Date.now()) { res.json(stats.value); return; }
      statsPending ??= Promise.all([unifiedConversationsService.getSalesResponseStats(), countUnifiedAttention()])
        .then(([salesStats, attentionCount]) => {
          const value = { salesStats, attentionCount };
          stats = { value, expires: Date.now() + 30_000 };
          return value;
        }).finally(() => { statsPending = undefined; });
      res.json(await statsPending);
    } catch (err) { next(err); }
  });

  router.get("/pages", requireRole("admin", "customer_service"), async (req, res, next) => {
    const parsed = z.object({
      search: z.string().max(200).optional(),
      leadSource: z.enum(["all", "abandoned_cart", "meta_form"]).optional(),
      onlyNeedsAttention: z.enum(["0", "1"]).optional(),
      cursor: z.string().max(2048).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      version: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    }).safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: "Invalid inbox filters or cursor." }); return; }
    try {
      res.set("Cache-Control", "private, no-store");
      const page = await listUnifiedConversationPage({ ...parsed.data, onlyNeedsAttention: parsed.data.onlyNeedsAttention === "1" });
      // Fingerprint includes row contents, order and next cursor.
      res.json(parsed.data.version === page.version ? { unchanged: true, version: page.version } : page);
    } catch (err) {
      if (err instanceof InvalidConversationCursor) { res.status(400).json({ error: err.message }); return; }
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
      stats = undefined;
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
      stats = undefined;
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
