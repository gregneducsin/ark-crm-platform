import { pgTable, text, uuid, integer, numeric, date, timestamp, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// See customers.ts's PERSON_NUMBER_SEQ_NAME comment — same reasoning applies
// here. Created as an idempotent bootstrap step in migrate.ts, not via
// drizzle-kit's pgSequence().
export const EMPLOYEE_NUMBER_SEQ_NAME = "employee_number_seq";

export const employeesTable = pgTable(
  "employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeNumber: text("employee_number")
      .notNull()
      .default(sql`('EMP-' || lpad(nextval('employee_number_seq')::text, 6, '0'))`),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    hourlyRate: numeric("hourly_rate", { precision: 10, scale: 2 }).notNull(),
    hireDate: date("hire_date", { mode: "string" }),
    status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("employees_employee_number_key").on(t.employeeNumber),
    uniqueIndex("employees_email_key").on(t.email),
    index("employees_status_idx").on(t.status),
  ],
);

export const payrollWeeksTable = pgTable(
  "payroll_weeks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    weekStart: date("week_start", { mode: "string" }).notNull(),
    weekEnd: date("week_end", { mode: "string" }).notNull(),
    status: text("status", { enum: ["draft", "approved", "paid"] }).notNull().default("draft"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidBy: text("paid_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("payroll_weeks_week_start_key").on(t.weekStart), index("payroll_weeks_status_idx").on(t.status)],
);

export const employeeWeeklyHoursTable = pgTable(
  "employee_weekly_hours",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payrollWeekId: uuid("payroll_week_id")
      .notNull()
      .references(() => payrollWeeksTable.id, { onDelete: "restrict" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employeesTable.id, { onDelete: "restrict" }),
    hoursWorked: numeric("hours_worked", { precision: 7, scale: 2 }).notNull(),
    hourlyRateSnapshot: numeric("hourly_rate_snapshot", { precision: 10, scale: 2 }).notNull(),
    hourlyEarnings: numeric("hourly_earnings", { precision: 12, scale: 2 }).notNull(),
    totalDeals: integer("total_deals"),
    commissionAmount: numeric("commission_amount", { precision: 12, scale: 2 }),
    commissionNotes: text("commission_notes"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("employee_weekly_hours_week_employee_key").on(t.payrollWeekId, t.employeeId),
    index("employee_weekly_hours_payroll_week_id_idx").on(t.payrollWeekId),
    index("employee_weekly_hours_employee_id_idx").on(t.employeeId),
  ],
);

export const employeeBonusesTable = pgTable(
  "employee_bonuses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payrollWeekId: uuid("payroll_week_id")
      .notNull()
      .references(() => payrollWeeksTable.id, { onDelete: "restrict" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employeesTable.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    description: text("description").notNull(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("employee_bonuses_payroll_week_id_idx").on(t.payrollWeekId),
    index("employee_bonuses_employee_id_idx").on(t.employeeId),
  ],
);

/** Append-only, same pattern as user_audit_events. */
export const payrollAuditEventsTable = pgTable(
  "payroll_audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payrollWeekId: uuid("payroll_week_id"),
    employeeId: uuid("employee_id"),
    action: text("action").notNull(),
    performedBy: text("performed_by").notNull(),
    previousValues: jsonb("previous_values"),
    newValues: jsonb("new_values"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("payroll_audit_events_payroll_week_id_idx").on(t.payrollWeekId),
    index("payroll_audit_events_employee_id_idx").on(t.employeeId),
  ],
);

export const marketingSpendWeeksTable = pgTable(
  "marketing_spend_weeks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    weekStart: date("week_start", { mode: "string" }).notNull(),
    weekEnd: date("week_end", { mode: "string" }).notNull(),
    // Nullable, independently — spend for one source can be entered before
    // the other, or left blank entirely ("spend not entered" in the UI,
    // distinct from an explicit $0).
    metaFormFillSpend: numeric("meta_form_fill_spend", { precision: 12, scale: 2 }),
    ecommerceSpend: numeric("ecommerce_spend", { precision: 12, scale: 2 }),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("marketing_spend_weeks_week_start_key").on(t.weekStart),
    index("marketing_spend_weeks_week_end_idx").on(t.weekEnd),
    check("msw_meta_spend_nonneg", sql`${t.metaFormFillSpend} >= 0`),
    check("msw_ecommerce_spend_nonneg", sql`${t.ecommerceSpend} >= 0`),
    check("msw_week_start_is_friday", sql`extract(isodow from ${t.weekStart}) = 5`),
    check("msw_week_end_is_thursday", sql`extract(isodow from ${t.weekEnd}) = 4`),
    check("msw_week_span", sql`${t.weekEnd} = ${t.weekStart} + 6`),
  ],
);

export type Employee = typeof employeesTable.$inferSelect;
export type InsertEmployee = typeof employeesTable.$inferInsert;
export type PayrollWeek = typeof payrollWeeksTable.$inferSelect;
