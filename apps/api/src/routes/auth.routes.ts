import { Router, type Router as RouterType } from "express";
import { loginRequestSchema, forgotPasswordRequestSchema, resetPasswordRequestSchema, acceptInvitationRequestSchema } from "@luma/shared";
import * as authService from "../services/auth.service.js";
import { issueCsrfCookieIfMissing, requireCsrf } from "../middleware/csrf.js";
import { createAuthLimiter } from "../middleware/rateLimit.js";
import { SESSION_COOKIE, SESSION_TTL_MS } from "../middleware/session.js";

export function createAuthRouter(): RouterType {
  const router: RouterType = Router();
  const authLimiter = createAuthLimiter();

  router.get("/csrf-token", (req, res) => {
    const csrfToken = issueCsrfCookieIfMissing(req, res);
    res.json({ csrfToken });
  });

  router.get("/me", (req, res) => {
    res.json({ user: req.user });
  });

  router.post("/login", authLimiter, requireCsrf, async (req, res, next) => {
    try {
      const parsed = loginRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }

      const result = await authService.login(parsed.data.email, parsed.data.password);
      if (!result.ok) {
        // Deliberately generic across all failure reasons — do not reveal
        // whether the email exists, is locked, or is unactivated.
        res.status(401).json({ error: "Invalid email or password." });
        return;
      }

      res.cookie(SESSION_COOKIE, result.rawSessionToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: SESSION_TTL_MS,
      });
      res.json({ user: result.user });
    } catch (err) {
      next(err);
    }
  });

  router.post("/logout", requireCsrf, async (req, res, next) => {
    try {
      if (req.sessionId) {
        await authService.revokeSession(req.sessionId);
      }
      res.clearCookie(SESSION_COOKIE, { path: "/" });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/forgot-password", authLimiter, requireCsrf, async (req, res, next) => {
    try {
      const parsed = forgotPasswordRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }

      // The raw link is intentionally NOT included in this response — see
      // auth.service.ts's requestPasswordReset for why (it's logged
      // server-side only, since no email transport is wired up yet). Echoing
      // it back here would let anyone reset anyone's password just by
      // knowing their email address.
      await authService.requestPasswordReset(parsed.data.email);
      res.json({ ok: true, message: "If that email exists, a reset link has been generated." });
    } catch (err) {
      next(err);
    }
  });

  router.post("/reset-password", authLimiter, requireCsrf, async (req, res, next) => {
    try {
      const parsed = resetPasswordRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }

      const result = await authService.resetPassword(parsed.data.token, parsed.data.password);
      if (!result.ok) {
        res.status(400).json({ error: "Invalid or expired reset link." });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/accept-invitation", authLimiter, requireCsrf, async (req, res, next) => {
    try {
      const parsed = acceptInvitationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }

      const result = await authService.acceptInvitation(parsed.data.token, parsed.data.password);
      if (!result.ok) {
        res.status(400).json({ error: "Invalid or expired invitation link." });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
