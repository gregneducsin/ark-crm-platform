import { eq } from "drizzle-orm";
import { db, employeesTable } from "@luma/db";
import type { CreateEmployeeRequest, UpdateEmployeeRequest } from "@luma/shared";

export async function listEmployees() {
  return db.select().from(employeesTable).orderBy(employeesTable.lastName);
}

export async function getEmployee(id: string) {
  const [employee] = await db.select().from(employeesTable).where(eq(employeesTable.id, id));
  return employee ?? null;
}

export async function createEmployee(input: CreateEmployeeRequest) {
  const [employee] = await db
    .insert(employeesTable)
    .values({
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      hourlyRate: input.hourlyRate,
      hireDate: input.hireDate,
      notes: input.notes,
    })
    .returning();
  return employee;
}

export async function updateEmployee(id: string, input: UpdateEmployeeRequest) {
  const [employee] = await db.update(employeesTable).set(input).where(eq(employeesTable.id, id)).returning();
  return employee ?? null;
}
