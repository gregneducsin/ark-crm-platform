import { Router, type Router as RouterType } from "express";

const router: RouterType = Router();

router.get("/health", (_req, res) => res.status(200).json({ ok: true }));
router.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

export default router;
