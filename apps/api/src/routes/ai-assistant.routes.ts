import { Router, type Router as RouterType } from "express";
import { askAiAssistantRequestSchema } from "@luma/shared";
import * as aiAssistantService from "../services/ai-assistant.service.js";
import { requireRole } from "../middleware/requireAuth.js";
import { requireCsrf } from "../middleware/csrf.js";
import { createAiAssistantLimiter } from "../middleware/rateLimit.js";

export function createAiAssistantRouter(): RouterType {
  const router: RouterType = Router();
  const limiter = createAiAssistantLimiter();

  router.post("/ask", limiter, requireRole("admin"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = askAiAssistantRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }
      const answer = await aiAssistantService.askAssistant(parsed.data.question, parsed.data.history ?? []);
      res.json({ answer });
    } catch (err) {
      if (err instanceof Error && err.message.includes("ANTHROPIC_API_KEY")) {
        res.status(503).json({ error: "The AI assistant isn't configured yet." });
        return;
      }
      next(err);
    }
  });

  return router;
}
