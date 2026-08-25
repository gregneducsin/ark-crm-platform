import { Router, type Router as RouterType } from "express";
import { createEmployeeRequestSchema, updateEmployeeRequestSchema } from "@luma/shared";
import * as employeesService from "../../services/employees.service.js";
import { requireRole } from "../../middleware/requireAuth.js";
import { requireCsrf } from "../../middleware/csrf.js";

export function createEmployeesRouter(): RouterType {
  const router: RouterType = Router();

  router.get("/", requireRole("admin", "manager"), async (_req, res, next) => {
    try {
      res.json({ employees: await employeesService.listEmployees() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", requireRole("admin", "manager"), async (req, res, next) => {
    try {
      const employee = await employeesService.getEmployee(req.params.id as string);
      if (!employee) {
        res.status(404).json({ error: "Employee not found." });
        return;
      }
      res.json({ employee });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", requireRole("admin", "manager"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = createEmployeeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }
      const employee = await employeesService.createEmployee(parsed.data);
      res.status(201).json({ employee });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id", requireRole("admin", "manager"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = updateEmployeeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request.", details: parsed.error.issues });
        return;
      }
      const employee = await employeesService.updateEmployee(req.params.id as string, parsed.data);
      if (!employee) {
        res.status(404).json({ error: "Employee not found." });
        return;
      }
      res.json({ employee });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
