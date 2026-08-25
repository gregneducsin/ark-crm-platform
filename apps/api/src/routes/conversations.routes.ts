import { Router, type Router as RouterType } from "express";
import { sendConversationReplyRequestSchema } from "@luma/shared";
import * as conversationsService from "../services/conversations.service.js";
import * as emailConversationsService from "../services/email-conversations.service.js";
import { sendEmailStaffReply } from "../services/alexis-email-dispatch.service.js";
import { requireRole } from "../middleware/requireAuth.js";
import { requireCsrf } from "../middleware/csrf.js";

/** SMS or email — same customer, same Alexis pipeline, two independent threads. Defaults to "sms" so every pre-existing caller of this router keeps its current behavior untouched. */
function channelFromQuery(req: { query: { channel?: unknown } }): "sms" | "email" {
  return req.query.channel === "email" ? "email" : "sms";
}

export function createConversationsRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/", requireRole("admin", "customer_service"), async (req, res, next) => {
    try {
      if (channelFromQuery(req) === "email") {
        const [conversations, stats] = await Promise.all([
          emailConversationsService.listEmailConversationSummaries(),
          emailConversationsService.getEmailConversationResponseStats(),
        ]);
        res.json({ conversations, stats });
        return;
      }
      const [conversations, stats] = await Promise.all([
        conversationsService.listConversationSummaries(),
        conversationsService.getConversationResponseStats(),
      ]);
      res.json({ conversations, stats });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", requireRole("admin", "customer_service"), async (req, res, next) => {
    try {
      const detail =
        channelFromQuery(req) === "email"
          ? await emailConversationsService.getEmailConversationDetail(req.params.id as string)
          : await conversationsService.getConversationDetail(req.params.id as string);
      if (!detail) {
        res.status(404).json({ error: "Conversation not found." });
        return;
      }
      res.json(detail);
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/clear-attention", requireRole("admin", "customer_service"), requireCsrf, async (req, res, next) => {
    try {
      const channel = channelFromQuery(req);
      if (channel === "email") {
        const detail = await emailConversationsService.getEmailConversationDetail(req.params.id as string);
        if (!detail) {
          res.status(404).json({ error: "Conversation not found." });
          return;
        }
        await emailConversationsService.updateEmailConversationState(req.params.id as string, { needsAttention: false, needsAttentionReason: null });
        res.json({ ok: true });
        return;
      }
      const detail = await conversationsService.getConversationDetail(req.params.id as string);
      if (!detail) {
        res.status(404).json({ error: "Conversation not found." });
        return;
      }
      await conversationsService.clearNeedsAttention(req.params.id as string);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/reply", requireRole("admin", "customer_service"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = sendConversationReplyRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid payload.", details: parsed.error.issues });
        return;
      }
      const result =
        channelFromQuery(req) === "email"
          ? await sendEmailStaffReply(req.params.id as string, parsed.data.body, req.user!.email)
          : await conversationsService.sendStaffReply(req.params.id as string, parsed.data.body, req.user!.email);
      if (!result.sent && result.reason === "not_found") {
        res.status(404).json({ error: "Conversation not found." });
        return;
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
