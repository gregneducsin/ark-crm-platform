import { db, userAuditEventsTable, payrollAuditEventsTable } from "@luma/db";

/**
 * Append-only audit trail write. Same pattern payroll (and eventually
 * messaging) audit events follow — see ARCHITECTURE.md.
 */
export async function writeUserAuditEvent(params: {
  actorUserId: string | null;
  targetUserId: string | null;
  action: string;
  previousValues?: unknown;
  newValues?: unknown;
}): Promise<void> {
  await db.insert(userAuditEventsTable).values({
    actorUserId: params.actorUserId,
    targetUserId: params.targetUserId,
    action: params.action,
    previousValues: params.previousValues as Record<string, unknown> | undefined,
    newValues: params.newValues as Record<string, unknown> | undefined,
  });
}

export async function writePayrollAuditEvent(params: {
  payrollWeekId: string | null;
  employeeId: string | null;
  action: string;
  performedBy: string;
  previousValues?: unknown;
  newValues?: unknown;
}): Promise<void> {
  await db.insert(payrollAuditEventsTable).values({
    payrollWeekId: params.payrollWeekId,
    employeeId: params.employeeId,
    action: params.action,
    performedBy: params.performedBy,
    previousValues: params.previousValues as Record<string, unknown> | undefined,
    newValues: params.newValues as Record<string, unknown> | undefined,
  });
}
