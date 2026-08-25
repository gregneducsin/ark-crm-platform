import { z } from "zod";

// ── Employees ──────────────────────────────────────────────────────────────────

export const employeeSchema = z.object({
  id: z.string().uuid(),
  employeeNumber: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().email(),
  phone: z.string().nullable(),
  hourlyRate: z.string(),
  hireDate: z.string().nullable(),
  status: z.enum(["active", "inactive"]),
  notes: z.string().nullable(),
});
export type Employee = z.infer<typeof employeeSchema>;

export const createEmployeeRequestSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(1).optional(),
  hourlyRate: z.string().regex(/^\d+(\.\d{1,2})?$/),
  hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().optional(),
});
export type CreateEmployeeRequest = z.infer<typeof createEmployeeRequestSchema>;

export const updateEmployeeRequestSchema = createEmployeeRequestSchema.partial().extend({
  status: z.enum(["active", "inactive"]).optional(),
});
export type UpdateEmployeeRequest = z.infer<typeof updateEmployeeRequestSchema>;

// ── Payroll weeks ──────────────────────────────────────────────────────────────

export const payrollWeekSchema = z.object({
  id: z.string().uuid(),
  weekStart: z.string(),
  weekEnd: z.string(),
  status: z.enum(["draft", "approved", "paid"]),
  approvedAt: z.string().nullable(),
  approvedBy: z.string().nullable(),
  paidAt: z.string().nullable(),
  paidBy: z.string().nullable(),
});
export type PayrollWeek = z.infer<typeof payrollWeekSchema>;

export const createPayrollWeekRequestSchema = z.object({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  weekEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type CreatePayrollWeekRequest = z.infer<typeof createPayrollWeekRequestSchema>;

// ── Employee weekly hours ───────────────────────────────────────────────────────

export const upsertWeeklyHoursRequestSchema = z.object({
  employeeId: z.string().uuid(),
  hoursWorked: z.string().regex(/^\d+(\.\d{1,2})?$/),
  totalDeals: z.number().int().min(0).optional(),
  commissionAmount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  commissionNotes: z.string().optional(),
  notes: z.string().optional(),
});
export type UpsertWeeklyHoursRequest = z.infer<typeof upsertWeeklyHoursRequestSchema>;

// ── Employee bonuses ───────────────────────────────────────────────────────────

export const createBonusRequestSchema = z.object({
  employeeId: z.string().uuid(),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  description: z.string().min(1),
});
export type CreateBonusRequest = z.infer<typeof createBonusRequestSchema>;

// ── Marketing spend weeks / CPA ───────────────────────────────────────────────

const moneyString = z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a decimal amount, e.g. 49.99");

// Only weekStart is client-supplied — it must be a Friday (enforced by a DB
// CHECK constraint too, this is just for a clean 400 instead of a raw
// constraint-violation error), weekEnd is always derived (Friday + 6 days).
export const createMarketingSpendWeekRequestSchema = z.object({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
  notes: z.string().optional(),
});
export type CreateMarketingSpendWeekRequest = z.infer<typeof createMarketingSpendWeekRequestSchema>;

// Each spend field: omit = don't change; "" = clear to null ("spend not
// entered"); a decimal string = set to that value (including "0" for an
// explicit zero, distinct from null).
const spendField = z.union([moneyString, z.literal("")]).optional();
export const updateMarketingSpendWeekRequestSchema = z.object({
  metaFormFillSpend: spendField,
  ecommerceSpend: spendField,
  notes: z.string().optional(),
});
export type UpdateMarketingSpendWeekRequest = z.infer<typeof updateMarketingSpendWeekRequestSchema>;

// Computed, not stored — leads/closed/revenue attributed to a lead cohort
// (the week the lead was *received*, not when they purchased), first-touch
// source only, first-order purchases only (recurring purchases are counted
// separately and excluded from every other figure here).
export const marketingCpaMetricsSchema = z.object({
  spend: z.string().nullable(),
  leadsReceived: z.number().int(),
  closedDeals: z.number().int(),
  stillOpen: z.number().int(),
  acquisitionRevenue: z.string(),
  conversionRate: z.number(),
  avgDaysToClose: z.number().nullable(),
  recurringExclusions: z.number().int(),
  cpa: z.number().nullable(),
});
export type MarketingCpaMetrics = z.infer<typeof marketingCpaMetricsSchema>;

export const marketingCpaWeekSchema = z.object({
  id: z.string().uuid(),
  weekStart: z.string(),
  weekEnd: z.string(),
  notes: z.string().nullable(),
  metaFormFill: marketingCpaMetricsSchema,
  ecommerce: marketingCpaMetricsSchema,
  combined: marketingCpaMetricsSchema,
});
export type MarketingCpaWeek = z.infer<typeof marketingCpaWeekSchema>;
