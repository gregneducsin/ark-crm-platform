import { Link } from "wouter";
import { useCustomersList } from "../hooks/useCustomers";
import { useEmployees, usePayrollWeeks } from "../hooks/usePayroll";
import { useCurrentUser } from "../hooks/useAuth";
import { useNeedsAttentionList } from "../hooks/useNeedsAttention";
import { useFunnelSummary } from "../hooks/useReporting";
import { Card, Badge } from "../components/ui";

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

function FunnelSummaryCard() {
  const { data } = useFunnelSummary();

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
  // limit: 100 is a pragmatic ceiling for a client-computed summary in this
  // phase — a real aggregate endpoint (computed in SQL, not paginated
  // client data) would be the right fix if the customer count grows well
  // beyond that.
  const { data: customersData } = useCustomersList({ limit: 100 });
  const { data: employeesData } = useEmployees();
  const { data: weeksData } = usePayrollWeeks();
  const { data: currentUser } = useCurrentUser();
  // Matches the real /needs-attention route guard (App.tsx, Layout.tsx) —
  // admin + customer_service, not manager, whose scope is payroll/Leads/Orders.
  const canSeeNeedsAttention = currentUser?.user?.role === "admin" || currentUser?.user?.role === "customer_service";

  const totalRevenue = customersData?.customers.reduce((sum, c) => sum + Number(c.totalPaid), 0) ?? 0;
  const activeEmployees = employeesData?.employees.filter((e) => e.status === "active").length ?? 0;
  const draftWeeks = weeksData?.weeks.filter((w) => w.status === "draft").length ?? 0;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <StatCard label="Leads" value={customersData?.total ?? "…"} />
        <StatCard label="Revenue" value={`$${totalRevenue.toFixed(2)}`} />
        <StatCard label="Active employees" value={activeEmployees} />
        <StatCard label="Draft payroll weeks" value={draftWeeks} />
        <NeedsAttentionCard enabled={canSeeNeedsAttention} />
      </div>
      {canSeeNeedsAttention && <FunnelSummaryCard />}
    </div>
  );
}
