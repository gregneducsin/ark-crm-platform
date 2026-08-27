import { useState } from "react";
import { Link } from "wouter";
import type { FailedPaymentItem, FailedPaymentResolutionStatus } from "@luma/shared";
import { useFailedPaymentsList, useResolveFailedPayment, useReopenFailedPayment } from "../hooks/useFailedPayments";
import { Badge, Card, Button } from "../components/ui";
import { formatDate } from "../lib/formatTime";

const STATUS_OPTIONS: { value: FailedPaymentResolutionStatus | "all"; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
];

function FailedPaymentRow({ item }: { item: FailedPaymentItem }) {
  const [expanded, setExpanded] = useState(false);
  const [notes, setNotes] = useState(item.notes ?? "");
  const resolve = useResolveFailedPayment();
  const reopen = useReopenFailedPayment();

  const cardLabel = item.cardBrand || item.cardLast4 ? `${item.cardBrand ?? "Card"} •••• ${item.cardLast4 ?? "????"}` : "—";

  return (
    <tr className="border-b border-gray-100 last:border-0 align-top hover:bg-gray-50">
      <td className="px-4 py-2 text-gray-600">
        {formatDate(item.failureDate)}
        {item.testMode && (
          <div className="mt-0.5">
            <Badge color="gray">test</Badge>
          </div>
        )}
      </td>
      <td className="px-4 py-2">
        {item.personId ? (
          <Link href={`/customers/${item.personId}`} className="font-medium text-blue-600 hover:underline">
            {item.firstName} {item.lastName}
          </Link>
        ) : (
          <span className="text-gray-500">Unmatched ({item.externalPersonId})</span>
        )}
        {item.email && <div className="text-xs text-gray-400">{item.email}</div>}
      </td>
      <td className="px-4 py-2 text-gray-600">{cardLabel}</td>
      <td className="px-4 py-2 text-right text-gray-800">{item.amount ? `$${item.amount}` : "—"}</td>
      <td className="px-4 py-2 text-gray-600">{item.transactionResponse ?? item.sourceStatus ?? "—"}</td>
      <td className="px-4 py-2">
        <Badge color={item.resolutionStatus === "open" ? "red" : "green"}>{item.resolutionStatus}</Badge>
      </td>
      <td className="px-4 py-2">
        {item.resolutionStatus === "open" ? (
          <div className="space-y-1">
            {!expanded ? (
              <Button variant="secondary" onClick={() => setExpanded(true)}>
                Resolve
              </Button>
            ) : (
              <div className="space-y-1">
                <textarea
                  className="w-56 rounded-md border border-gray-300 px-2 py-1 text-xs"
                  rows={2}
                  placeholder="Optional note (e.g. how it was resolved)"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
                <div className="flex gap-1">
                  <Button
                    disabled={resolve.isPending}
                    onClick={() => resolve.mutate({ id: item.id, notes: notes.trim() || undefined }, { onSuccess: () => setExpanded(false) })}
                  >
                    {resolve.isPending ? "Saving…" : "Confirm"}
                  </Button>
                  <Button variant="secondary" onClick={() => setExpanded(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            {item.notes && <p className="max-w-xs text-xs text-gray-500">{item.notes}</p>}
            <Button variant="secondary" disabled={reopen.isPending} onClick={() => reopen.mutate(item.id)}>
              {reopen.isPending ? "Reopening…" : "Reopen"}
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}

export function FailedPaymentsPage() {
  const [status, setStatus] = useState<FailedPaymentResolutionStatus | "all">("open");
  const { data, isLoading } = useFailedPaymentsList(status);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Failed Payments</h1>
        {data && <p className="text-sm text-gray-500">{data.items.length} {status === "all" ? "total" : status}</p>}
      </div>
      <p className="text-xs text-gray-400">
        Every payment-failure event Bask has sent, corrected automatically on the order and the customer's own record — this is where staff decide
        what to do about each one (follow up, write it off) and mark it resolved.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <select className="rounded-md border border-gray-300 px-3 py-1.5 text-sm" value={status} onChange={(e) => setStatus(e.target.value as FailedPaymentResolutionStatus | "all")}>
          {STATUS_OPTIONS.map((o) => (
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
                <th className="px-4 py-2">Failed</th>
                <th className="px-4 py-2">Customer</th>
                <th className="px-4 py-2">Card</th>
                <th className="px-4 py-2 text-right">Amount</th>
                <th className="px-4 py-2">Reason</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((item) => (
                <FailedPaymentRow key={item.id} item={item} />
              ))}
              {data?.items.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-sm text-gray-400">
                    No {status === "all" ? "" : status} failed payments.
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
