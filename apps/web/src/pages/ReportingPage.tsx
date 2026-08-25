import { useFunnelSummary, useMessageReporting } from "../hooks/useReporting";
import { Card } from "../components/ui";

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "—";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = hours / 24;
  return `${days.toFixed(1)}d`;
}

function FunnelSection() {
  const { data, isLoading } = useFunnelSummary();

  const stages = data
    ? [
        { label: "Leads", value: data.totalLeads, ofPrevious: null },
        { label: "Started questionnaire", value: data.questionnaireStarted, ofPrevious: pct(data.questionnaireStarted, data.totalLeads) },
        { label: "Submitted questionnaire", value: data.questionnaireSubmitted, ofPrevious: pct(data.questionnaireSubmitted, data.questionnaireStarted) },
        { label: "Purchased", value: data.purchased, ofPrevious: pct(data.purchased, data.questionnaireSubmitted) },
      ]
    : [];

  return (
    <Card>
      <h2 className="text-sm font-semibold text-gray-900">Lead → Purchase Funnel</h2>
      <p className="mt-1 text-xs text-gray-400">All-time, distinct customers at each stage. Percentage is of the stage immediately before it.</p>
      {isLoading && <p className="mt-4 text-sm text-gray-400">Loading…</p>}
      {data && (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stages.map((s) => (
            <div key={s.label}>
              <p className="text-xs font-medium uppercase text-gray-400">{s.label}</p>
              <p className="mt-1 text-2xl font-semibold text-gray-900">{s.value}</p>
              {s.ofPrevious !== null && <p className="text-xs text-gray-400">{s.ofPrevious} of previous stage</p>}
            </div>
          ))}
        </div>
      )}
      {data && data.totalLeads > 0 && (
        <p className="mt-3 text-xs text-gray-400">Overall lead-to-purchase conversion: {pct(data.purchased, data.totalLeads)}</p>
      )}
    </Card>
  );
}

function MessagingSection() {
  const { data, isLoading } = useMessageReporting();

  return (
    <Card>
      <h2 className="text-sm font-semibold text-gray-900">Messaging</h2>
      <p className="mt-1 text-xs text-gray-400">All-time message volume and average response time (an outbound reply directly following an inbound message), by channel.</p>
      {isLoading && <p className="mt-4 text-sm text-gray-400">Loading…</p>}
      {data && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs font-medium uppercase text-gray-400">
                <th className="py-2 pr-4">Channel</th>
                <th className="py-2 pr-4">Inbound</th>
                <th className="py-2 pr-4">Outbound</th>
                <th className="py-2 pr-4">Avg response time</th>
                <th className="py-2">Responses counted</th>
              </tr>
            </thead>
            <tbody>
              {data.volume.map((v) => {
                const rt = data.responseTimes.find((r) => r.channel === v.channel);
                return (
                  <tr key={v.channel} className="border-b border-gray-100">
                    <td className="py-2 pr-4 font-medium capitalize text-gray-900">{v.channel}</td>
                    <td className="py-2 pr-4 text-gray-600">{v.inbound}</td>
                    <td className="py-2 pr-4 text-gray-600">{v.outbound}</td>
                    <td className="py-2 pr-4 text-gray-600">{formatDuration(rt?.avgResponseSeconds ?? null)}</td>
                    <td className="py-2 text-gray-600">{rt?.responseCount ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function ReportingPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-gray-900">Reporting</h1>
      <FunnelSection />
      <MessagingSection />
    </div>
  );
}
