import { Router, type Router as RouterType } from "express";
import * as needsAttentionService from "../services/needs-attention.service.js";
import { requireRole } from "../middleware/requireAuth.js";
import { requireCsrf } from "../middleware/csrf.js";

const CHANNELS = new Set(["sms", "email"]);
const PERSONAS = new Set(["alexis", "sophie"]);

export function createNeedsAttentionRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/", requireRole("admin", "customer_service"), async (_req, res, next) => {
    try {
      const items = await needsAttentionService.listNeedsAttention();
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:channel/:persona/:id/messages", requireRole("admin", "customer_service"), async (req, res, next) => {
    try {
      const { channel, persona, id } = req.params;
      if (!CHANNELS.has(channel as string) || !PERSONAS.has(persona as string)) {
        res.status(400).json({ error: "Invalid channel or persona." });
        return;
      }
      const messages = await needsAttentionService.getNeedsAttentionMessages(channel as "sms" | "email", persona as "alexis" | "sophie", id as string);
      res.json({ messages });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:channel/:persona/:id/clear", requireRole("admin", "customer_service"), requireCsrf, async (req, res, next) => {
    try {
      const { channel, persona, id } = req.params;
      if (!CHANNELS.has(channel as string) || !PERSONAS.has(persona as string)) {
        res.status(400).json({ error: "Invalid channel or persona." });
        return;
      }
      await needsAttentionService.clearNeedsAttentionItem(channel as "sms" | "email", persona as "alexis" | "sophie", id as string);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
