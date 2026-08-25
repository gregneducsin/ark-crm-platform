import { useMemo, useState, type FormEvent } from "react";
import type { MarketingCpaMetrics, MarketingCpaWeek } from "@luma/shared";
import { useCreateMarketingSpendWeek, useMarketingCpaWeeks, useUpdateMarketingSpendWeek } from "../hooks/usePayroll";
import { Button, Card, ErrorText, Field, Input, Modal } from "../components/ui";
import { ApiError } from "../hooks/useAuth";

type ViewMode = "weekly" | "monthly";

function isFriday(dateStr: string): boolean {
  // Parsed as UTC midnight so local timezone can't shift the weekday.
  const d = new Date(`${dateStr}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.getUTCDay() === 5;
}

function addDaysUTC(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10) as string;
}

function money(v: string | null): string {
  return v === null ? "—" : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function monthLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

function combineMonthly(weeks: MarketingCpaWeek[], key: "metaFormFill" | "ecommerce" | "combined"): MarketingCpaMetrics {
  let leadsReceived = 0;
  let closedDeals = 0;
  let stillOpen = 0;
  let revenue = 0;
  let recurringExclusions = 0;
  let spendTotal = 0;
  let spendKnown = false;
  let weightedDaysSum = 0;

  for (const week of weeks) {
    const m = week[key];
    leadsReceived += m.leadsReceived;
    closedDeals += m.closedDeals;
    stillOpen += m.stillOpen;
    revenue += Number(m.acquisitionRevenue);
    recurringExclusions += m.recurringExclusions;
    if (m.spend !== null) {
      spendKnown = true;
      spendTotal += Number(m.spend);
    }
    if (m.avgDaysToClose !== null) {
      weightedDaysSum += m.avgDaysToClose * m.closedDeals;
    }
  }

  const conversionRate = leadsReceived > 0 ? Math.round((closedDeals / leadsReceived) * 1000) / 10 : 0;
  const avgDaysToClose = closedDeals > 0 ? Math.round((weightedDaysSum / closedDeals) * 10) / 10 : null;
  const spend = spendKnown ? spendTotal.toFixed(2) : null;
  const cpa = spend !== null && closedDeals > 0 ? Math.round((Number(spend) / closedDeals) * 100) / 100 : null;

  return {
    spend,
    leadsReceived,
    closedDeals,
    stillOpen,
    acquisitionRevenue: revenue.toFixed(2),
    conversionRate,
    avgDaysToClose,
    recurringExclusions,
    cpa,
  };
}

function MetricCard({ title, metrics }: { title: string; metrics: MarketingCpaMetrics }) {
  return (
    <Card>
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</p>
      <div className="mt-3 space-y-2 text-sm">
        <Row label="Ad spend" value={money(metrics.spend)} />
        <Row label="CPA" value={metrics.cpa === null ? "—" : `$${metrics.cpa.toFixed(2)}`} emphasize />
        <Row label="Leads received" value={String(metrics.leadsReceived)} />
        <Row label="Closed deals" value={String(metrics.closedDeals)} />
        <Row label="Acquisition revenue" value={money(metrics.acquisitionRevenue)} />
        <Row label="Conversion rate" value={`${metrics.conversionRate}%`} />
        <Row label="Avg days to close" value={metrics.avgDaysToClose === null ? "—" : String(metrics.avgDaysToClose)} />
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-gray-100 pt-2 text-xs text-gray-400">
        <span>{metrics.stillOpen} still open</span>
        <span>{metrics.recurringExclusions} recurring exclusions</span>
      </div>
    </Card>
  );
}

function Row({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-500">{label}</span>
      <span className={emphasize ? "text-base font-semibold text-gray-900" : "font-medium text-gray-800"}>{value}</span>
    </div>
  );
}

export function MarketingCpaPage() {
  const { data, isLoading } = useMarketingCpaWeeks();
  const [mode, setMode] = useState<ViewMode>("weekly");
  const [weekIndex, setWeekIndex] = useState(0);
  const [monthIndex, setMonthIndex] = useState(0);
  const [showAddPeriod, setShowAddPeriod] = useState(false);
  const [showManageSpend, setShowManageSpend] = useState(false);

  // Oldest-first so "next" moves forward in time.
  const weeks = useMemo(() => [...(data?.weeks ?? [])].sort((a, b) => a.weekStart.localeCompare(b.weekStart)), [data]);

  const months = useMemo(() => {
    const byMonth = new Map<string, MarketingCpaWeek[]>();
    for (const week of weeks) {
      const key = week.weekStart.slice(0, 7);
      const list = byMonth.get(key) ?? [];
      list.push(week);
      byMonth.set(key, list);
    }
    return [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [weeks]);

  const clampedWeekIndex = Math.min(weekIndex, Math.max(weeks.length - 1, 0));
  const clampedMonthIndex = Math.min(monthIndex, Math.max(months.length - 1, 0));
  const currentWeek = weeks[clampedWeekIndex];
  const currentMonth = months[clampedMonthIndex];

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Marketing CPA</h1>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-gray-300 bg-white p-0.5 text-sm">
            <button
              type="button"
              onClick={() => setMode("weekly")}
              className={`rounded px-3 py-1 ${mode === "weekly" ? "bg-blue-600 text-white" : "text-gray-600"}`}
            >
              Weekly
            </button>
            <button
              type="button"
              onClick={() => setMode("monthly")}
              className={`rounded px-3 py-1 ${mode === "monthly" ? "bg-blue-600 text-white" : "text-gray-600"}`}
            >
              Monthly
            </button>
          </div>
          <Button variant="secondary" onClick={() => setShowAddPeriod(true)}>
            Add CPA period
          </Button>
        </div>
      </div>

      {weeks.length === 0 ? (
        <Card>
          <p className="text-sm text-gray-500">No CPA periods yet. Add one to start tracking marketing spend.</p>
        </Card>
      ) : mode === "weekly" && currentWeek ? (
        <>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setWeekIndex((i) => Math.max(i - 1, 0))}
              disabled={clampedWeekIndex === 0}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40"
            >
              ← Prev
            </button>
            <div className="text-center">
              <p className="text-sm font-medium text-gray-900">
                {currentWeek.weekStart} – {currentWeek.weekEnd}
              </p>
              <Button variant="secondary" className="mt-1" onClick={() => setShowManageSpend(true)}>
                Manage spend
              </Button>
            </div>
            <button
              type="button"
              onClick={() => setWeekIndex((i) => Math.min(i + 1, weeks.length - 1))}
              disabled={clampedWeekIndex === weeks.length - 1}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40"
            >
              Next →
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <MetricCard title="Meta form fill" metrics={currentWeek.metaFormFill} />
            <MetricCard title="E-commerce" metrics={currentWeek.ecommerce} />
            <MetricCard title="Combined" metrics={currentWeek.combined} />
          </div>

          {showManageSpend && <ManageSpendModal week={currentWeek} onClose={() => setShowManageSpend(false)} />}
        </>
      ) : mode === "monthly" && currentMonth ? (
        <>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setMonthIndex((i) => Math.max(i - 1, 0))}
              disabled={clampedMonthIndex === 0}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40"
            >
              ← Prev
            </button>
            <p className="text-sm font-medium text-gray-900">{monthLabel(currentMonth[0])}</p>
            <button
              type="button"
              onClick={() => setMonthIndex((i) => Math.min(i + 1, months.length - 1))}
              disabled={clampedMonthIndex === months.length - 1}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40"
            >
              Next →
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <MetricCard title="Meta form fill" metrics={combineMonthly(currentMonth[1], "metaFormFill")} />
            <MetricCard title="E-commerce" metrics={combineMonthly(currentMonth[1], "ecommerce")} />
            <MetricCard title="Combined" metrics={combineMonthly(currentMonth[1], "combined")} />
          </div>
        </>
      ) : null}

      <Card className="overflow-x-auto p-0">
        <p className="border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs font-semibold uppercase text-gray-500">All periods</p>
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 text-left text-xs font-medium uppercase text-gray-500">
            <tr>
              <th className="px-4 py-2">Period</th>
              <th className="px-4 py-2 text-right">Leads</th>
              <th className="px-4 py-2 text-right">Closed</th>
              <th className="px-4 py-2 text-right">Meta CPA</th>
              <th className="px-4 py-2 text-right">Eco CPA</th>
              <th className="px-4 py-2 text-right">Combined CPA</th>
            </tr>
          </thead>
          <tbody>
            {[...weeks].reverse().map((w, idx) => (
              <tr key={w.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                <td className="px-4 py-2">
                  <button
                    type="button"
                    onClick={() => {
                      setMode("weekly");
                      setWeekIndex(weeks.length - 1 - idx);
                    }}
                    className="font-medium text-blue-600 hover:underline"
                  >
                    {w.weekStart} – {w.weekEnd}
                  </button>
                </td>
                <td className="px-4 py-2 text-right text-gray-700">{w.combined.leadsReceived}</td>
                <td className="px-4 py-2 text-right text-gray-700">{w.combined.closedDeals}</td>
                <td className="px-4 py-2 text-right text-gray-700">{w.metaFormFill.cpa === null ? "—" : `$${w.metaFormFill.cpa.toFixed(2)}`}</td>
                <td className="px-4 py-2 text-right text-gray-700">{w.ecommerce.cpa === null ? "—" : `$${w.ecommerce.cpa.toFixed(2)}`}</td>
                <td className="px-4 py-2 text-right font-medium text-gray-900">
                  {w.combined.cpa === null ? "—" : `$${w.combined.cpa.toFixed(2)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {showAddPeriod && (
        <AddPeriodModal
          onClose={() => setShowAddPeriod(false)}
          onCreated={(newWeekStart) => {
            setShowAddPeriod(false);
            setMode("weekly");
            // Land on the newly created week once the list refetches.
            const idx = weeks.findIndex((w) => w.weekStart === newWeekStart);
            if (idx >= 0) setWeekIndex(idx);
          }}
        />
      )}
    </div>
  );
}

function AddPeriodModal({ onClose, onCreated }: { onClose: () => void; onCreated: (weekStart: string) => void }) {
  const [weekStart, setWeekStart] = useState("");
  const createWeek = useCreateMarketingSpendWeek();
  const validFriday = weekStart === "" || isFriday(weekStart);
  const weekEndPreview = weekStart && validFriday ? addDaysUTC(weekStart, 6) : null;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isFriday(weekStart)) return;
    createWeek.mutate({ weekStart }, { onSuccess: () => onCreated(weekStart) });
  }

  return (
    <Modal title="Add CPA period" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <Field label="Period start (must be a Friday)">
          <Input type="date" required value={weekStart} onChange={(e) => setWeekStart(e.target.value)} />
        </Field>
        {!validFriday && <ErrorText>Period start must be a Friday.</ErrorText>}
        {weekEndPreview && <p className="text-xs text-gray-500">Period end (Thursday): {weekEndPreview}</p>}
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={createWeek.isPending || !weekStart || !validFriday}>
            {createWeek.isPending ? "Creating…" : "Create period"}
          </Button>
          <ErrorText>
            {createWeek.isError ? (createWeek.error instanceof ApiError ? createWeek.error.message : "Something went wrong.") : null}
          </ErrorText>
        </div>
      </form>
    </Modal>
  );
}

function ManageSpendModal({ week, onClose }: { week: MarketingCpaWeek; onClose: () => void }) {
  const [metaFormFillSpend, setMetaFormFillSpend] = useState(week.metaFormFill.spend ?? "");
  const [ecommerceSpend, setEcommerceSpend] = useState(week.ecommerce.spend ?? "");
  const updateWeek = useUpdateMarketingSpendWeek(week.id);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    updateWeek.mutate({ metaFormFillSpend, ecommerceSpend }, { onSuccess: onClose });
  }

  return (
    <Modal title={`Manage spend — ${week.weekStart} – ${week.weekEnd}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <Field label="Meta form fill spend">
          <Input
            type="number"
            step="0.01"
            min="0"
            placeholder="0.00"
            value={metaFormFillSpend}
            onChange={(e) => setMetaFormFillSpend(e.target.value)}
          />
        </Field>
        <Field label="E-commerce spend">
          <Input type="number" step="0.01" min="0" placeholder="0.00" value={ecommerceSpend} onChange={(e) => setEcommerceSpend(e.target.value)} />
        </Field>
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={updateWeek.isPending}>
            {updateWeek.isPending ? "Saving…" : "Save spend"}
          </Button>
          <ErrorText>
            {updateWeek.isError ? (updateWeek.error instanceof ApiError ? updateWeek.error.message : "Something went wrong.") : null}
          </ErrorText>
        </div>
      </form>
    </Modal>
  );
}
