import { and, eq } from "drizzle-orm";
import { db, payrollWeeksTable, employeeWeeklyHoursTable, employeeBonusesTable, employeesTable } from "@luma/db";
import { calculateHourlyEarnings, type CreatePayrollWeekRequest, type UpsertWeeklyHoursRequest, type CreateBonusRequest } from "@luma/shared";
import { writePayrollAuditEvent } from "./audit.service.js";

export async function listPayrollWeeks() {
  return db.select().from(payrollWeeksTable).orderBy(payrollWeeksTable.weekStart);
}

export async function getPayrollWeekDetail(id: string) {
  const [week] = await db.select().from(payrollWeeksTable).where(eq(payrollWeeksTable.id, id));
  if (!week) return null;

  const hours = await db
    .select({
      id: employeeWeeklyHoursTable.id,
      employeeId: employeeWeeklyHoursTable.employeeId,
      employeeFirstName: employeesTable.firstName,
      employeeLastName: employeesTable.lastName,
      hoursWorked: employeeWeeklyHoursTable.hoursWorked,
      hourlyRateSnapshot: employeeWeeklyHoursTable.hourlyRateSnapshot,
      hourlyEarnings: employeeWeeklyHoursTable.hourlyEarnings,
      totalDeals: employeeWeeklyHoursTable.totalDeals,
      commissionAmount: employeeWeeklyHoursTable.commissionAmount,
    })
    .from(employeeWeeklyHoursTable)
    .innerJoin(employeesTable, eq(employeeWeeklyHoursTable.employeeId, employeesTable.id))
    .where(eq(employeeWeeklyHoursTable.payrollWeekId, id));

  const bonuses = await db.select().from(employeeBonusesTable).where(eq(employeeBonusesTable.payrollWeekId, id));

  return { week, hours, bonuses };
}

export async function createPayrollWeek(input: CreatePayrollWeekRequest) {
  const [week] = await db
    .insert(payrollWeeksTable)
    .values({ weekStart: input.weekStart, weekEnd: input.weekEnd })
    .returning();
  return week;
}

const STATUS_TRANSITIONS: Record<string, string> = { draft: "approved", approved: "paid" };

async function transitionPayrollWeekStatus(
  id: string,
  toStatus: "approved" | "paid",
  actor: { id: string; email: string },
): Promise<{ ok: true; week: typeof payrollWeeksTable.$inferSelect } | { ok: false; error: string }> {
  return db.transaction(async (tx) => {
    const [week] = await tx.select().from(payrollWeeksTable).where(eq(payrollWeeksTable.id, id));
    if (!week) return { ok: false, error: "Payroll week not found." };

    if (STATUS_TRANSITIONS[week.status] !== toStatus) {
      return { ok: false, error: `Cannot transition from "${week.status}" to "${toStatus}".` };
    }

    const now = new Date();
    const patch =
      toStatus === "approved"
        ? { status: "approved" as const, approvedAt: now, approvedBy: actor.email }
        : { status: "paid" as const, paidAt: now, paidBy: actor.email };

    const [updated] = await tx.update(payrollWeeksTable).set(patch).where(eq(payrollWeeksTable.id, id)).returning();

    await writePayrollAuditEvent({
      payrollWeekId: id,
      employeeId: null,
      action: `week_${toStatus}`,
      performedBy: actor.email,
      previousValues: { status: week.status },
      newValues: { status: toStatus },
    });

    return { ok: true, week: updated! };
  });
}

export function approvePayrollWeek(id: string, actor: { id: string; email: string }) {
  return transitionPayrollWeekStatus(id, "approved", actor);
}

export function payPayrollWeek(id: string, actor: { id: string; email: string }) {
  return transitionPayrollWeekStatus(id, "paid", actor);
}

export async function upsertWeeklyHours(
  weekId: string,
  input: UpsertWeeklyHoursRequest,
  actor: { id: string; email: string },
): Promise<{ ok: true; entry: typeof employeeWeeklyHoursTable.$inferSelect } | { ok: false; error: string }> {
  return db.transaction(async (tx) => {
    const [week] = await tx.select().from(payrollWeeksTable).where(eq(payrollWeeksTable.id, weekId));
    if (!week) return { ok: false, error: "Payroll week not found." };
    if (week.status !== "draft") return { ok: false, error: "Hours can only be entered on a draft week." };

    const [employee] = await tx.select().from(employeesTable).where(eq(employeesTable.id, input.employeeId));
    if (!employee) return { ok: false, error: "Employee not found." };

    const hourlyEarnings = calculateHourlyEarnings(input.hoursWorked, employee.hourlyRate);

    const [existing] = await tx
      .select({ id: employeeWeeklyHoursTable.id, hoursWorked: employeeWeeklyHoursTable.hoursWorked, hourlyEarnings: employeeWeeklyHoursTable.hourlyEarnings })
      .from(employeeWeeklyHoursTable)
      .where(and(eq(employeeWeeklyHoursTable.payrollWeekId, weekId), eq(employeeWeeklyHoursTable.employeeId, input.employeeId)));

    const values = {
      payrollWeekId: weekId,
      employeeId: input.employeeId,
      hoursWorked: input.hoursWorked,
      hourlyRateSnapshot: employee.hourlyRate,
      hourlyEarnings,
      totalDeals: input.totalDeals,
      commissionAmount: input.commissionAmount,
      commissionNotes: input.commissionNotes,
      notes: input.notes,
      createdBy: actor.email,
      updatedBy: actor.email,
    };

    const [entry] = await tx
      .insert(employeeWeeklyHoursTable)
      .values(values)
      .onConflictDoUpdate({
        target: [employeeWeeklyHoursTable.payrollWeekId, employeeWeeklyHoursTable.employeeId],
        set: { ...values, updatedAt: new Date() },
      })
      .returning();

    await writePayrollAuditEvent({
      payrollWeekId: weekId,
      employeeId: input.employeeId,
      action: existing ? "hours_updated" : "hours_entered",
      performedBy: actor.email,
      previousValues: existing ? { hoursWorked: existing.hoursWorked, hourlyEarnings: existing.hourlyEarnings } : undefined,
      newValues: { hoursWorked: input.hoursWorked, hourlyEarnings },
    });

    return { ok: true, entry: entry! };
  });
}

export async function createBonus(
  weekId: string,
  input: CreateBonusRequest,
  actor: { id: string; email: string },
): Promise<{ ok: true; bonus: typeof employeeBonusesTable.$inferSelect } | { ok: false; error: string }> {
  return db.transaction(async (tx) => {
    const [week] = await tx.select().from(payrollWeeksTable).where(eq(payrollWeeksTable.id, weekId));
    if (!week) return { ok: false, error: "Payroll week not found." };
    if (week.status !== "draft") return { ok: false, error: "Bonuses can only be added on a draft week." };

    const [bonus] = await tx
      .insert(employeeBonusesTable)
      .values({
        payrollWeekId: weekId,
        employeeId: input.employeeId,
        amount: input.amount,
        description: input.description,
        createdBy: actor.email,
        updatedBy: actor.email,
      })
      .returning();

    await writePayrollAuditEvent({
      payrollWeekId: weekId,
      employeeId: input.employeeId,
      action: "bonus_added",
      performedBy: actor.email,
      newValues: { amount: input.amount, description: input.description },
    });

    return { ok: true, bonus: bonus! };
  });
}
