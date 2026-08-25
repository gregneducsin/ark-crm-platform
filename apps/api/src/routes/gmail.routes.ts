import {
  Router,
  type Router as RouterType,
} from "express";
import { requireRole } from "../middleware/requireAuth.js";
import { requireCsrf } from "../middleware/csrf.js";
import { sendGmailTestMessage } from "../services/gmail.service.js";

export function createGmailRouter(): RouterType {
  const router: RouterType = Router();

  router.post(
    "/test-send",
    requireRole("admin"),
    requireCsrf,
    async (req, res, next) => {
      try {
        const to =
          typeof req.body?.to === "string"
            ? req.body.to
            : "";

        if (!to) {
          res.status(400).json({
            error: "A recipient email address is required.",
          });
          return;
        }

        const result = await sendGmailTestMessage(to);

        res.json({
          ok: true,
          messageId: result.id,
          threadId: result.threadId,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
