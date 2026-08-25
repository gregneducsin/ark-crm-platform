import { Router, type Router as RouterType } from "express";
import { handleIntakeLinkClick } from "../services/intake-links.service.js";

/**
 * Public, unauthenticated redirect endpoint — the destination of a trigger
 * link sent to a lead. Not mounted under /api/app (no session/CSRF, it's a
 * customer clicking a link, not a browser session against our dashboard) or
 * /api/webhooks (no shared-secret caller, it's a person's browser).
 */
export function createIntakeLinksRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/:token", async (req, res, next) => {
    try {
      const { redirectUrl } = await handleIntakeLinkClick(req.params.token);
      res.redirect(302, redirectUrl);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
