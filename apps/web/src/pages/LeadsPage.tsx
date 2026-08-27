import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { useCustomersList, useCreateCustomer, useCustomersSummary, useLeadTypes, useQuestionnaireIds } from "../hooks/useCustomers";
import { Badge, Button, Card, ErrorText, Field, Input } from "../components/ui";
import { ApiError, useCurrentUser } from "../hooks/useAuth";
import type { CustomersSummaryQuery } from "@luma/shared";

const PERIOD_OPTIONS: { value: CustomersSummaryQuery["period"]; label: string }[] = [
  { value: 7, label: "Last 7 Days" },
  { value: 30, label: "Last 30 Days" },
  { value: 90, label: "Last 90 Days" },
  { value: "all", label: "All Time" },
];

function SummaryTile({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <p className="text-xs font-medium uppercase text-gray-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
    </Card>
  );
}

function SummaryBar() {
  const [period, setPeriod] = useState<CustomersSummaryQuery["period"]>(30);
  const { data } = useCustomersSummary({ period });
  const periodLabel = PERIOD_OPTIONS.find((p) => p.value === period)?.label ?? "";

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Summary for <span className="font-medium text-gray-900">{periodLabel}</span>
        </p>
        <select
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
          value={String(period)}
          onChange={(e) => setPeriod(e.target.value === "all" ? "all" : Number(e.target.value))}
        >
          {PERIOD_OPTIONS.map((p) => (
            <option key={p.label} value={String(p.value)}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <SummaryTile label="Total leads" value={data?.totalLeads ?? "…"} />
        <SummaryTile label="Meta form fill" value={data?.metaFormFillCount ?? "…"} />
        <SummaryTile label="Questionnaire" value={data?.questionnaireCount ?? "…"} />
        <SummaryTile label="Purchased" value={data?.purchased ?? "…"} />
        <SummaryTile label="Not purchased" value={data?.notPurchased ?? "…"} />
        <SummaryTile label="Conversion rate" value={data ? `${data.conversionRate}%` : "…"} />
      </div>
    </Card>
  );
}

const QUESTIONNAIRE_BADGE_COLOR: Record<string, "gray" | "green" | "yellow" | "blue"> = {
  started: "blue",
  abandoned: "yellow",
  submitted: "green",
};

const LEAD_TYPE_BADGE_COLOR: Record<string, "gray" | "green" | "yellow" | "blue" | "purple"> = {
  "Meta Form Fill": "blue",
  Questionnaire: "purple",
};

/** Whole days between two YYYY-MM-DD dates, or null if either is missing. Never negative — a purchase can't precede the lead. */
function daysBetween(fromDate: string | null, toDate: string | null): number | null {
  if (!fromDate || !toDate) return null;
  const ms = new Date(toDate).getTime() - new Date(fromDate).getTime();
  return Math.max(0, Math.round(ms / (1000 * 60 * 60 * 24)));
}

function formatMoney(amount: string): string {
  return `$${Number(amount).toFixed(2)}`;
}

type SortBy = "createdAt" | "leadReceivedDate" | "lastName";

const PAGE_SIZE = 25;

function SortHeader({
  label,
  column,
  sortBy,
  sortDir,
  onSort,
}: {
  label: string;
  column: SortBy;
  sortBy: SortBy;
  sortDir: "asc" | "desc";
  onSort: (column: SortBy) => void;
}) {
  const active = sortBy === column;
  return (
    <th className="px-6 py-2">
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`flex items-center gap-1 font-medium uppercase ${active ? "text-gray-900" : "text-gray-500 hover:text-gray-700"}`}
      >
        {label}
        <span className="text-[10px]">{active ? (sortDir === "asc" ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
}

export function LeadsPage() {
  const [search, setSearch] = useState("");
  const [leadType, setLeadType] = useState("");
  const [purchaseStatus, setPurchaseStatus] = useState("");
  const [questionnaireId, setQuestionnaireId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("leadReceivedDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const { data: currentUser } = useCurrentUser();
  const canEdit = currentUser?.user?.role === "admin";

  function handleSort(column: SortBy) {
    setPage(0);
    if (column === sortBy) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(column);
      setSortDir("desc");
    }
  }

  // Every filter/search input resets to page 0 — otherwise narrowing the
  // result set can strand the view on a now-nonexistent later page, which
  // renders as "No leads found" even though matches exist on page 0.
  function updateFilter<T>(setter: (v: T) => void) {
    return (v: T) => {
      setPage(0);
      setter(v);
    };
  }

  const { data: leadTypesData } = useLeadTypes();
  const { data: questionnaireIdsData } = useQuestionnaireIds();
  const { data, isLoading } = useCustomersList({
    search: search || undefined,
    leadType: leadType || undefined,
    purchaseStatus: (purchaseStatus || undefined) as "purchased" | "not_purchased" | undefined,
    questionnaireId: questionnaireId || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    sortBy,
    sortDir,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  const total = data?.total ?? 0;
  const hasNextPage = (page + 1) * PAGE_SIZE < total;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Leads</h1>
        {canEdit && <Button onClick={() => setShowCreate((s) => !s)}>{showCreate ? "Cancel" : "New lead"}</Button>}
      </div>

      <SummaryBar />

      {canEdit && showCreate && <CreateCustomerForm onDone={() => setShowCreate(false)} />}

      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="max-w-xs"
          placeholder="Search by name, email, or phone…"
          value={search}
          onChange={(e) => updateFilter(setSearch)(e.target.value)}
        />
        <select
          className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          value={leadType}
          onChange={(e) => updateFilter(setLeadType)(e.target.value)}
        >
          <option value="">All Lead Types</option>
          {leadTypesData?.leadTypes.map((lt) => (
            <option key={lt} value={lt}>
              {lt}
            </option>
          ))}
        </select>
        <select
          className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          value={purchaseStatus}
          onChange={(e) => updateFilter(setPurchaseStatus)(e.target.value)}
        >
          <option value="">All Purchases</option>
          <option value="purchased">Purchased</option>
          <option value="not_purchased">Not Purchased</option>
        </select>
        <select
          className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          value={questionnaireId}
          onChange={(e) => updateFilter(setQuestionnaireId)(e.target.value)}
        >
          <option value="">All Questionnaires</option>
          {questionnaireIdsData?.questionnaireIds.map((qid) => (
            <option key={qid} value={qid}>
              {qid}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">Lead received</span>
          <Input type="date" className="w-auto" value={dateFrom} onChange={(e) => updateFilter(setDateFrom)(e.target.value)} />
          <span className="text-sm text-gray-400">–</span>
          <Input type="date" className="w-auto" value={dateTo} onChange={(e) => updateFilter(setDateTo)(e.target.value)} />
          {(dateFrom || dateTo) && (
            <button
              type="button"
              onClick={() => {
                setPage(0);
                setDateFrom("");
                setDateTo("");
              }}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <p className="p-4 text-sm text-gray-500">Loading…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <tr>
                <SortHeader label="Lead" column="lastName" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <th className="px-3 py-2">Contact</th>
                <th className="px-3 py-2">Lead type</th>
                <SortHeader label="Lead created" column="leadReceivedDate" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <th className="px-3 py-2">Questionnaire / Funnel</th>
                <th className="px-3 py-2">Purchase</th>
                <th className="px-3 py-2">First purchase</th>
                <th className="px-3 py-2">Orders / Spent</th>
              </tr>
            </thead>
            <tbody>
              {data?.customers.map((c) => {
                const daysToPurchase = daysBetween(c.leadReceivedDate, c.qualifyingPurchaseDate);
                return (
                  <tr key={c.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <Link href={`/customers/${c.id}`} className="font-medium text-blue-600 hover:underline">
                        {c.firstName} {c.lastName}
                      </Link>
                      <div className="text-xs text-gray-400">{c.personNumber}</div>
                    </td>
                    <td className="px-3 py-2 text-gray-600">
                      <div>{c.email}</div>
                      {c.phone && <div className="text-xs text-gray-400">{c.phone}</div>}
                    </td>
                    <td className="px-3 py-2">
                      <Badge color={LEAD_TYPE_BADGE_COLOR[c.leadType] ?? "gray"}>{c.leadType}</Badge>
                    </td>
                    <td className="px-3 py-2 text-gray-600">{c.leadReceivedDate}</td>
                    <td className="px-3 py-2">
                      {c.questionnaireStatus ? (
                        <div>
                          {c.questionnaireId && <div className="text-xs text-gray-600">{c.questionnaireId}</div>}
                          <Badge color={QUESTIONNAIRE_BADGE_COLOR[c.questionnaireStatus] ?? "gray"}>{c.questionnaireStatus}</Badge>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">Not started</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {c.qualifyingPurchaseDate ? (
                        <Badge color="green">Purchased</Badge>
                      ) : (
                        <Badge color="gray">Not purchased</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-600">
                      {c.qualifyingPurchaseDate ?? "—"}
                      {daysToPurchase !== null && <div className="text-xs text-gray-400">{daysToPurchase} days</div>}
                    </td>
                    <td className="px-3 py-2 text-gray-600">
                      {c.purchaseCount} order{c.purchaseCount === 1 ? "" : "s"}
                      <div className="text-xs text-gray-400">{formatMoney(c.totalPaid)}</div>
                    </td>
                  </tr>
                );
              })}
              {data?.customers.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-sm text-gray-400">
                    No leads found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </Card>
      {data && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-400">
            {total === 0 ? "0 total" : `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total}`}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
              Previous
            </Button>
            <Button variant="secondary" onClick={() => setPage((p) => p + 1)} disabled={!hasNextPage}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CreateCustomerForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", phone: "", leadReceivedDate: "" });
  const createCustomer = useCreateCustomer();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    createCustomer.mutate(
      { ...form, phone: form.phone || undefined },
      { onSuccess: onDone },
    );
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-3">
        <Field label="First name">
          <Input required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
        </Field>
        <Field label="Last name">
          <Input required value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
        </Field>
        <Field label="Email">
          <Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Phone (optional)">
          <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Lead received date">
          <Input
            type="date"
            required
            value={form.leadReceivedDate}
            onChange={(e) => setForm({ ...form, leadReceivedDate: e.target.value })}
          />
        </Field>
        <div className="col-span-2 flex items-center gap-2">
          <Button type="submit" disabled={createCustomer.isPending}>
            {createCustomer.isPending ? "Creating…" : "Create lead"}
          </Button>
          <ErrorText>
            {createCustomer.isError
              ? createCustomer.error instanceof ApiError
                ? createCustomer.error.message
                : "Something went wrong."
              : null}
          </ErrorText>
        </div>
      </form>
    </Card>
  );
}
