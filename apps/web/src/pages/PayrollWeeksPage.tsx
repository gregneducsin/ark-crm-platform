import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { usePayrollWeeks, useCreatePayrollWeek } from "../hooks/usePayroll";
import { Badge, Button, Card, ErrorText, Field, Input } from "../components/ui";
import { ApiError } from "../hooks/useAuth";

const STATUS_COLORS: Record<string, "gray" | "green" | "yellow" | "blue"> = {
  draft: "gray",
  approved: "blue",
  paid: "green",
};

export function PayrollWeeksPage() {
  const [showCreate, setShowCreate] = useState(false);
  const { data, isLoading } = usePayrollWeeks();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Payroll weeks</h1>
        <Button onClick={() => setShowCreate((s) => !s)}>{showCreate ? "Cancel" : "New week"}</Button>
      </div>

      {showCreate && <CreateWeekForm onDone={() => setShowCreate(false)} />}

      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <p className="p-4 text-sm text-gray-500">Loading…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2">Week</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {data?.weeks.map((w) => (
                <tr key={w.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <Link href={`/payroll/weeks/${w.id}`} className="font-medium text-blue-600 hover:underline">
                      {w.weekStart} – {w.weekEnd}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <Badge color={STATUS_COLORS[w.status]}>{w.status}</Badge>
                  </td>
                </tr>
              ))}
              {data?.weeks.length === 0 && (
                <tr>
                  <td colSpan={2} className="px-4 py-6 text-center text-sm text-gray-400">
                    No payroll weeks yet.
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

function CreateWeekForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ weekStart: "", weekEnd: "" });
  const createWeek = useCreatePayrollWeek();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    createWeek.mutate(form, { onSuccess: onDone });
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-3">
        <Field label="Week start">
          <Input type="date" required value={form.weekStart} onChange={(e) => setForm({ ...form, weekStart: e.target.value })} />
        </Field>
        <Field label="Week end">
          <Input type="date" required value={form.weekEnd} onChange={(e) => setForm({ ...form, weekEnd: e.target.value })} />
        </Field>
        <div className="col-span-2 flex items-center gap-2">
          <Button type="submit" disabled={createWeek.isPending}>
            {createWeek.isPending ? "Creating…" : "Create week"}
          </Button>
          <ErrorText>
            {createWeek.isError ? (createWeek.error instanceof ApiError ? createWeek.error.message : "Something went wrong.") : null}
          </ErrorText>
        </div>
      </form>
    </Card>
  );
}
