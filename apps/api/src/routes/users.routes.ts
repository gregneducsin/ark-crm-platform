import { Router, type Router as RouterType } from "express";
import { inviteUserRequestSchema, updateUserRequestSchema } from "@luma/shared";
import * as authService from "../services/auth.service.js";
import { requireRole } from "../middleware/requireAuth.js";
import { requireCsrf } from "../middleware/csrf.js";

/** Admin-only: manage staff accounts (list, invite, change role/status). Role assignment happens here, not via self-service signup. */
export function createUsersRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/", requireRole("admin"), async (_req, res, next) => {
    try {
      const users = await authService.listUsers();
      res.json({ users });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", requireRole("admin"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = inviteUserRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }
      const result = await authService.inviteUser({ ...parsed.data, actorUserId: req.user!.id });
      if (!result.ok) {
        res.status(409).json({ error: "A user with that email already exists." });
        return;
      }
      res.status(201).json({ user: result.user });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id", requireRole("admin"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = updateUserRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }
      const result = await authService.updateUser(req.params.id as string, parsed.data, req.user!.id);
      if (!result.ok) {
        if (result.reason === "self") {
          res.status(400).json({ error: "You can't change your own role or status." });
          return;
        }
        res.status(404).json({ error: "User not found." });
        return;
      }
      res.json({ user: result.user });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
