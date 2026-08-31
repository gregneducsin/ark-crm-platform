import { useState } from "react";
import { Link } from "wouter";
import type { WebhookEventItem, WebhookEventStatus } from "@luma/shared";
import { useWebhookEventsList } from "../hooks/useWebhookEvents";
import { Badge, Card, Button } from "../components/ui";
import { formatDate } from "../lib/formatTime";

const STATUS_OPTIONS: { value: WebhookEventStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "failed", label: "Failed" },
  { value: "received", label: "Received" },
  { value: "processed", label: "Processed" },
];

const SOURCE_OPTIONS = [
  { value: "", label: "All sources" },
  { value: "ghl_lead", label: "GHL Lead" },
  { value: "bask_order", label: "Bask Order" },
  { value: "bask_questionnaire", label: "Bask Questionnaire" },
  { value: "bask_payment_failed", label: "Bask Payment Failed" },
  { value: "bask_payment_succeeded", label: "Bask Payment Succeeded" },
  { value: "bask_payment_refunded", label: "Bask Payment Refunded" },
  { value: "bask_prescription_written", label: "Bask Prescription Written" },
  { value: "bask_order_shipped", label: "Bask Order Shipped" },
  { value: "iblusend_message", label: "iBluSend Message" },
  { value: "email_inbound", label: "Email Inbound" },
];

function statusColor(status: WebhookEventStatus): "red" | "green" | "gray" {
  if (status === "failed") return "red";
  if (status === "processed") return "green";
  return "gray";
}

function WebhookEventRow({ item }: { item: WebhookEventItem }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr className="border-b border-gray-100 last:border-0 align-top hover:bg-gray-50">
        <td className="px-4 py-2 text-gray-600">{formatDate(item.receivedAt)}</td>
        <td className="px-4 py-2 text-gray-800">{item.source}</td>
        <td className="px-4 py-2">
          <Badge color={statusColor(item.status)}>{item.status}</Badge>
        </td>
        <td className="px-4 py-2">
          {item.personId ? (
            <Link href={`/customers/${item.personId}`} className="font-medium text-ark-blue-600 hover:underline">
              {item.customerName || "(no name)"}
            </Link>
          ) : (
            <span className="text-gray-400">—</span>
          )}
        </td>
        <td className="px-4 py-2 max-w-xs text-xs text-red-600">{item.errorMessage ?? ""}</td>
        <td className="px-4 py-2">
          <Button variant="secondary" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Hide payload" : "View payload"}
          </Button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-gray-100 last:border-0 bg-gray-50">
          <td colSpan={6} className="px-4 py-3">
            <pre className="max-h-96 overflow-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">{JSON.stringify(item.rawPayload, null, 2)}</pre>
          </td>
        </tr>
      )}
    </>
  );
}

export function WebhookEventsPage() {
  const [status, setStatus] = useState<WebhookEventStatus | "all">("all");
  const [source, setSource] = useState("");
  const { data, isLoading } = useWebhookEventsList(status, source || undefined);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ark-ink">Webhook Log</h1>
        {data && <p className="text-sm text-gray-500">{data.items.length} shown</p>}
      </div>
      <p className="text-xs text-gray-400">
        Every inbound webhook delivery — GHL, Bask, iBluSend — including ones that failed validation before we ever processed them. Use "View payload" to see
        exactly what was sent, and the error message to see why it was rejected. Refreshes automatically every 15s.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <select className="rounded-md border border-gray-300 px-3 py-1.5 text-sm" value={status} onChange={(e) => setStatus(e.target.value as WebhookEventStatus | "all")}>
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select className="rounded-md border border-gray-300 px-3 py-1.5 text-sm" value={source} onChange={(e) => setSource(e.target.value)}>
          {SOURCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <p className="p-4 text-sm text-gray-500">Loading…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2">Received</th>
                <th className="px-4 py-2">Source</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Customer</th>
                <th className="px-4 py-2">Error</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((item) => (
                <WebhookEventRow key={item.id} item={item} />
              ))}
              {data?.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-sm text-gray-400">
                    No webhook deliveries yet.
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
