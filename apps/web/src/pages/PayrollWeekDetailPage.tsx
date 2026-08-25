import { useState, type FormEvent } from "react";
import { useParams } from "wouter";
import {
  usePayrollWeekDetail,
  useUpsertWeeklyHours,
  useCreateBonus,
  useApprovePayrollWeek,
  usePayPayrollWeek,
  useEmployees,
} from "../hooks/usePayroll";
import { Badge, Button, Card, ErrorText, Field, Input } from "../components/ui";
import { ApiError } from "../hooks/useAuth";

export function PayrollWeekDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = usePayrollWeekDetail(id);
  const approve = useApprovePayrollWeek(id!);
  const pay = usePayPayrollWeek(id!);

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>;
  if (!data) return <p className="text-sm text-gray-500">Payroll week not found.</p>;

  const { week, hours, bonuses } = data;
  const isDraft = week.status === "draft";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">
            {week.weekStart} – {week.weekEnd}
          </h1>
          <Badge color={week.status === "paid" ? "green" : week.status === "approved" ? "blue" : "gray"}>{week.status}</Badge>
        </div>
        <div className="flex gap-2">
          {week.status === "draft" && (
            <Button onClick={() => approve.mutate()} disabled={approve.isPending}>
              {approve.isPending ? "Approving…" : "Approve week"}
            </Button>
          )}
          {week.status === "approved" && (
            <Button onClick={() => pay.mutate()} disabled={pay.isPending}>
              {pay.isPending ? "Marking paid…" : "Mark as paid"}
            </Button>
          )}
        </div>
      </div>
      <ErrorText>
        {approve.isError ? (approve.error instanceof ApiError ? approve.error.message : "Something went wrong.") : null}
        {pay.isError ? (pay.error instanceof ApiError ? pay.error.message : "Something went wrong.") : null}
      </ErrorText>

      {isDraft && <HoursEntryForm weekId={week.id} />}

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
            <tr>
              <th className="px-4 py-2">Employee</th>
              <th className="px-4 py-2 text-right">Hours</th>
              <th className="px-4 py-2 text-right">Rate</th>
              <th className="px-4 py-2 text-right">Earnings</th>
            </tr>
          </thead>
          <tbody>
            {hours.map((h) => (
              <tr key={h.id} className="border-b border-gray-100 last:border-0">
                <td className="px-4 py-2 text-gray-800">
                  {h.employeeFirstName} {h.employeeLastName}
                </td>
                <td className="px-4 py-2 text-right text-gray-600">{h.hoursWorked}</td>
                <td className="px-4 py-2 text-right text-gray-600">${h.hourlyRateSnapshot}</td>
                <td className="px-4 py-2 text-right font-medium text-gray-800">${h.hourlyEarnings}</td>
              </tr>
            ))}
            {hours.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-sm text-gray-400">
                  No hours entered yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {isDraft && <BonusForm weekId={week.id} />}

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
            <tr>
              <th className="px-4 py-2">Bonus description</th>
              <th className="px-4 py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {bonuses.map((b) => (
              <tr key={b.id} className="border-b border-gray-100 last:border-0">
                <td className="px-4 py-2 text-gray-800">{b.description}</td>
                <td className="px-4 py-2 text-right text-gray-600">${b.amount}</td>
              </tr>
            ))}
            {bonuses.length === 0 && (
              <tr>
                <td colSpan={2} className="px-4 py-6 text-center text-sm text-gray-400">
                  No bonuses yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function HoursEntryForm({ weekId }: { weekId: string }) {
  const { data: employeesData } = useEmployees();
  const [employeeId, setEmployeeId] = useState("");
  const [hoursWorked, setHoursWorked] = useState("");
  const upsertHours = useUpsertWeeklyHours(weekId);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    upsertHours.mutate(
      { employeeId, hoursWorked },
      { onSuccess: () => setHoursWorked("") },
    );
  }

  return (
    <Card>
      <h2 className="mb-2 text-sm font-semibold text-gray-900">Enter hours</h2>
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <Field label="Employee">
          <select
            required
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
          >
            <option value="" disabled>
              Select…
            </option>
            {employeesData?.employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.firstName} {emp.lastName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Hours worked">
          <Input required placeholder="40" value={hoursWorked} onChange={(e) => setHoursWorked(e.target.value)} className="w-24" />
        </Field>
        <Button type="submit" disabled={upsertHours.isPending}>
          {upsertHours.isPending ? "Saving…" : "Save hours"}
        </Button>
        <ErrorText>
          {upsertHours.isError ? (upsertHours.error instanceof ApiError ? upsertHours.error.message : "Something went wrong.") : null}
        </ErrorText>
      </form>
    </Card>
  );
}

function BonusForm({ weekId }: { weekId: string }) {
  const { data: employeesData } = useEmployees();
  const [employeeId, setEmployeeId] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const createBonus = useCreateBonus(weekId);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    createBonus.mutate(
      { employeeId, amount, description },
      { onSuccess: () => { setAmount(""); setDescription(""); } },
    );
  }

  return (
    <Card>
      <h2 className="mb-2 text-sm font-semibold text-gray-900">Add bonus</h2>
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <Field label="Employee">
          <select
            required
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
          >
            <option value="" disabled>
              Select…
            </option>
            {employeesData?.employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.firstName} {emp.lastName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Amount">
          <Input required placeholder="50.00" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-28" />
        </Field>
        <Field label="Description">
          <Input required value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Button type="submit" disabled={createBonus.isPending}>
          {createBonus.isPending ? "Adding…" : "Add bonus"}
        </Button>
        <ErrorText>
          {createBonus.isError ? (createBonus.error instanceof ApiError ? createBonus.error.message : "Something went wrong.") : null}
        </ErrorText>
      </form>
    </Card>
  );
}
