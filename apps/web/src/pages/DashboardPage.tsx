import { useState } from "react";
import { Link } from "wouter";
import { useEmployees, usePayrollWeeks } from "../hooks/usePayroll";
import { useCurrentUser } from "../hooks/useAuth";
import { useNeedsAttentionList } from "../hooks/useNeedsAttention";
import { useFunnelSummary } from "../hooks/useReporting";
import { Card, Badge } from "../components/ui";
import type { DateRangeQuery } from "@luma/shared";

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <p className="text-xs font-medium uppercase text-gray-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
    </Card>
  );
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "—";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function NeedsAttentionCard({ enabled }: { enabled: boolean }) {
  const { data } = useNeedsAttentionList(enabled);
  if (!enabled) return null;
  const count = data?.items.length ?? 0;

  return (
    <Link href="/needs-attention">
      <Card className={"cursor-pointer transition-colors hover:bg-gray-50 " + (count > 0 ? "border-red-200" : "")}>
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium uppercase text-gray-400">Needs Attention</p>
          {count > 0 && <Badge color="red">flagged</Badge>}
        </div>
        <p className="mt-1 text-2xl font-semibold text-gray-900">{data === undefined ? "…" : count}</p>
        <p className="mt-1 text-xs text-gray-400">Across SMS and email — click to review</p>
      </Card>
    </Link>
  );
}

type RangePreset = "24h" | "7d" | "1m" | "custom";

const RANGE_PRESET_LABEL: Record<RangePreset, string> = {
  "24h": "24 Hours",
  "7d": "7 Days",
  "1m": "1 Month",
  custom: "Custom",
};

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Resolves a preset to a concrete {from, to} — both YYYY-MM-DD, inclusive. Returns undefined for "custom" (the caller supplies from/to directly instead). */
function presetToRange(preset: RangePreset): DateRangeQuery | undefined {
  if (preset === "custom") return undefined;
  const daysBack = preset === "24h" ? 0 : preset === "7d" ? 6 : 29;
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - daysBack);
  return { from: toDateStr(from), to: toDateStr(to) };
}

function DateRangePicker({
  preset,
  customFrom,
  customTo,
  onPresetChange,
  onCustomChange,
}: {
  preset: RangePreset;
  customFrom: string;
  customTo: string;
  onPresetChange: (p: RangePreset) => void;
  onCustomChange: (from: string, to: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex gap-1">
        {(["24h", "7d", "1m", "custom"] as const).map((p) => (
          <button
            key={p}
            onClick={() => onPresetChange(p)}
            className={"rounded px-2 py-1 text-xs font-medium " + (preset === p ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600")}
          >
            {RANGE_PRESET_LABEL[p]}
          </button>
        ))}
      </div>
      {preset === "custom" && (
        <div className="flex items-center gap-1">
          <input
            type="date"
            value={customFrom}
            max={customTo || undefined}
            onChange={(e) => onCustomChange(e.target.value, customTo)}
            className="rounded-md border border-gray-300 px-2 py-1 text-xs"
          />
          <span className="text-xs text-gray-400">to</span>
          <input
            type="date"
            value={customTo}
            min={customFrom || undefined}
            onChange={(e) => onCustomChange(customFrom, e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1 text-xs"
          />
        </div>
      )}
    </div>
  );
}

function FunnelSummaryCard({ range, enabled }: { range?: DateRangeQuery; enabled: boolean }) {
  const { data } = useFunnelSummary(range, enabled);
  if (!enabled) return null;

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Lead → Purchase Funnel</h2>
        <Link href="/reporting" className="text-xs font-medium text-blue-600 hover:underline">
          Full report →
        </Link>
      </div>
      {!data && <p className="mt-3 text-sm text-gray-400">Loading…</p>}
      {data && (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <p className="text-xs font-medium uppercase text-gray-400">Leads</p>
            <p className="mt-1 text-xl font-semibold text-gray-900">{data.totalLeads}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase text-gray-400">Started</p>
            <p className="mt-1 text-xl font-semibold text-gray-900">{data.questionnaireStarted}</p>
            <p className="text-xs text-gray-400">{pct(data.questionnaireStarted, data.totalLeads)}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase text-gray-400">Submitted</p>
            <p className="mt-1 text-xl font-semibold text-gray-900">{data.questionnaireSubmitted}</p>
            <p className="text-xs text-gray-400">{pct(data.questionnaireSubmitted, data.questionnaireStarted)}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase text-gray-400">Purchased</p>
            <p className="mt-1 text-xl font-semibold text-gray-900">{data.purchased}</p>
            <p className="text-xs text-gray-400">{pct(data.purchased, data.questionnaireSubmitted)}</p>
          </div>
        </div>
      )}
    </Card>
  );
}

export function DashboardPage() {
  const [preset, setPreset] = useState<RangePreset>("7d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const range = preset === "custom" ? (customFrom && customTo ? { from: customFrom, to: customTo } : undefined) : presetToRange(preset);

  const { data: currentUser } = useCurrentUser();
  // Matches the real /needs-attention route guard (App.tsx, Layout.tsx) —
  // admin + customer_service, not manager, whose scope is payroll/Leads/Orders.
  const canSeeNeedsAttention = currentUser?.user?.role === "admin" || currentUser?.user?.role === "customer_service";
  // Matches /api/app/reporting/funnel's own role gate, and /payroll/*'s route
  // guard in App.tsx — manager has both, customer_service has neither.
  const canSeeFunnelStats = currentUser?.user?.role === "admin" || currentUser?.user?.role === "manager";
  const { data: funnelData } = useFunnelSummary(range, canSeeFunnelStats);
  const { data: employeesData } = useEmployees(canSeeFunnelStats);
  const { data: weeksData } = usePayrollWeeks(canSeeFunnelStats);

  const activeEmployees = employeesData?.employees.filter((e) => e.status === "active").length ?? 0;
  const draftWeeks = weeksData?.weeks.filter((w) => w.status === "draft").length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>
        <DateRangePicker
          preset={preset}
          customFrom={customFrom}
          customTo={customTo}
          onPresetChange={setPreset}
          onCustomChange={(from, to) => {
            setCustomFrom(from);
            setCustomTo(to);
          }}
        />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <StatCard label="Leads" value={canSeeFunnelStats ? (funnelData?.totalLeads ?? "…") : "—"} />
        <StatCard label="Revenue" value={canSeeFunnelStats ? `$${(funnelData?.revenue ?? 0).toFixed(2)}` : "—"} />
        <StatCard label="Active employees" value={canSeeFunnelStats ? activeEmployees : "—"} />
        <StatCard label="Draft payroll weeks" value={canSeeFunnelStats ? draftWeeks : "—"} />
        <NeedsAttentionCard enabled={canSeeNeedsAttention} />
      </div>
      <FunnelSummaryCard range={range} enabled={canSeeFunnelStats} />
    </div>
  );
}
