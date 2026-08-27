import { useState, type FormEvent } from "react";
import { useEmployees, useCreateEmployee } from "../hooks/usePayroll";
import { Badge, Button, Card, ErrorText, Field, Input } from "../components/ui";
import { ApiError } from "../hooks/useAuth";
import { PayrollSubNav } from "../components/PayrollSubNav";

export function PayrollEmployeesPage() {
  const [showCreate, setShowCreate] = useState(false);
  const { data, isLoading } = useEmployees();

  return (
    <div className="space-y-4">
      <PayrollSubNav />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Employees</h1>
        <Button onClick={() => setShowCreate((s) => !s)}>{showCreate ? "Cancel" : "New employee"}</Button>
      </div>

      {showCreate && <CreateEmployeeForm onDone={() => setShowCreate(false)} />}

      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <p className="p-4 text-sm text-gray-500">Loading…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2 text-right">Hourly rate</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {data?.employees.map((e) => (
                <tr key={e.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-2 text-gray-800">
                    {e.firstName} {e.lastName}
                    <div className="text-xs text-gray-400">{e.employeeNumber}</div>
                  </td>
                  <td className="px-4 py-2 text-gray-600">{e.email}</td>
                  <td className="px-4 py-2 text-right text-gray-600">${e.hourlyRate}/hr</td>
                  <td className="px-4 py-2">
                    <Badge color={e.status === "active" ? "green" : "gray"}>{e.status}</Badge>
                  </td>
                </tr>
              ))}
              {data?.employees.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-sm text-gray-400">
                    No employees yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function CreateEmployeeForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", hourlyRate: "" });
  const createEmployee = useCreateEmployee();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    createEmployee.mutate(form, { onSuccess: onDone });
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="First name">
          <Input required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
        </Field>
        <Field label="Last name">
          <Input required value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
        </Field>
        <Field label="Email">
          <Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Hourly rate">
          <Input required placeholder="20.00" value={form.hourlyRate} onChange={(e) => setForm({ ...form, hourlyRate: e.target.value })} />
        </Field>
        <div className="col-span-2 flex items-center gap-2 sm:col-span-4">
          <Button type="submit" disabled={createEmployee.isPending}>
            {createEmployee.isPending ? "Creating…" : "Create employee"}
          </Button>
          <ErrorText>
            {createEmployee.isError
              ? createEmployee.error instanceof ApiError
                ? createEmployee.error.message
                : "Something went wrong."
              : null}
          </ErrorText>
        </div>
      </form>
    </Card>
  );
}
