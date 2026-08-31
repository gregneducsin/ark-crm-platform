import { useState, type FormEvent } from "react";
import { useParams, Link } from "wouter";
import { useCustomer, useCreatePurchase, useUpdatePurchase, useCreateIntakeLink } from "../hooks/useCustomers";
import { Badge, Button, Card, ErrorText, Field, Input } from "../components/ui";
import { ApiError, useCurrentUser } from "../hooks/useAuth";
import { formatDate, formatDateTime } from "../lib/formatTime";
import { CustomerNotesCard } from "../components/CustomerNotesCard";

const STATUS_COLORS: Record<string, "gray" | "green" | "yellow" | "red"> = {
  pending: "yellow",
  completed: "green",
  refunded: "gray",
  cancelled: "red",
};

const QUESTIONNAIRE_BADGE_COLOR: Record<string, "gray" | "green" | "yellow" | "blue"> = {
  started: "blue",
  abandoned: "yellow",
  submitted: "green",
};

export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useCustomer(id);
  const [showAddPurchase, setShowAddPurchase] = useState(false);
  const { data: currentUser } = useCurrentUser();
  const canEdit = currentUser?.user?.role === "admin";

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>;
  if (!data) return <p className="text-sm text-gray-500">Customer not found.</p>;

  const { customer, purchases, questionnaireEvents } = data;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">
            {customer.firstName} {customer.lastName}
          </h1>
          <p className="text-sm text-gray-500">{customer.personNumber}</p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/conversations?personId=${customer.id}`}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            View in Conversations →
          </Link>
        </div>
      </div>

      <Card>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-gray-400">Email</dt>
            <dd className="text-gray-800">{customer.email}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">Phone</dt>
            <dd className="text-gray-800">{customer.phone ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">Lead type</dt>
            <dd className="text-gray-800">{customer.leadType}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">Lead received</dt>
            <dd className="text-gray-800">{customer.leadReceivedDate}</dd>
          </div>
        </dl>
      </Card>

      <CustomerNotesCard customerId={customer.id} />

      {questionnaireEvents.length > 0 && (
        <Card>
          <h2 className="text-sm font-semibold text-gray-900">Questionnaire / Funnel</h2>
          <p className="text-xs text-gray-500">Where this lead came from — every questionnaire they have an event for, most recent first.</p>
          <div className="mt-3 space-y-2">
            {questionnaireEvents.map((qe) => (
              <div key={qe.questionnaireId} className="flex items-center justify-between rounded-md border border-gray-100 px-3 py-2">
                <span className="text-sm text-gray-800">{qe.questionnaireId}</span>
                <div className="flex items-center gap-2">
                  <Badge color={QUESTIONNAIRE_BADGE_COLOR[qe.status] ?? "gray"}>{qe.status}</Badge>
                  <span className="text-xs text-gray-400">as of {formatDate(qe.lastEventAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {canEdit && <IntakeLinkCard customerId={customer.id} />}

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Purchase history</h2>
        {canEdit && <Button onClick={() => setShowAddPurchase((s) => !s)}>{showAddPurchase ? "Cancel" : "Add purchase"}</Button>}
      </div>

      {canEdit && showAddPurchase && <AddPurchaseForm customerId={customer.id} onDone={() => setShowAddPurchase(false)} />}

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
            <tr>
              <th className="px-4 py-2">Date</th>
              <th className="px-4 py-2">Order #</th>
              <th className="px-4 py-2">Product</th>
              <th className="px-4 py-2 text-right">Amount</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Classification</th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((p) => (
              <PurchaseRow key={p.id} purchase={p} customerId={customer.id} canEdit={canEdit} />
            ))}
            {purchases.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-gray-400">
                  No purchases yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function IntakeLinkCard({ customerId }: { customerId: string }) {
  const createLink = useCreateIntakeLink(customerId);
  const [copied, setCopied] = useState(false);

  async function handleCopy(url: string) {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Signup link</h2>
          <p className="text-xs text-gray-500">
            Only send this once the lead has actually agreed to fill out the form — it starts the 2-hour follow-up timer as soon as
            they click it.
          </p>
        </div>
        <Button onClick={() => createLink.mutate()} disabled={createLink.isPending}>
          {createLink.isPending ? "Generating…" : "Generate link"}
        </Button>
      </div>

      {createLink.isSuccess && (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 p-2">
          <input readOnly className="flex-1 bg-transparent text-sm text-gray-800 outline-none" value={createLink.data.url} />
          <Button variant="secondary" onClick={() => handleCopy(createLink.data.url)}>
            {copied ? "Copied!" : "Copy"}
          </Button>
        </div>
      )}
      {createLink.isSuccess && (
        <p className="mt-1 text-xs text-gray-400">Expires {formatDateTime(createLink.data.expiresAt)}</p>
      )}

      <ErrorText>
        {createLink.isError ? (createLink.error instanceof ApiError ? createLink.error.message : "Something went wrong.") : null}
      </ErrorText>
    </Card>
  );
}

function PurchaseRow({
  purchase,
  customerId,
  canEdit,
}: {
  purchase: { id: number; purchaseDate: string; orderNumber: string; productName: string; amountPaid: string; status: string; orderClassification: string | null };
  customerId: string;
  canEdit: boolean;
}) {
  const updatePurchase = useUpdatePurchase(customerId);

  return (
    <tr className="border-b border-gray-100 last:border-0">
      <td className="px-4 py-2 text-gray-600">{purchase.purchaseDate}</td>
      <td className="px-4 py-2 text-gray-600">{purchase.orderNumber}</td>
      <td className="px-4 py-2 text-gray-600">{purchase.productName}</td>
      <td className="px-4 py-2 text-right text-gray-600">${purchase.amountPaid}</td>
      <td className="px-4 py-2">
        <Badge color={STATUS_COLORS[purchase.status] ?? "gray"}>{purchase.status}</Badge>
      </td>
      <td className="px-4 py-2">
        {!canEdit ? (
          <span className="text-xs text-gray-600">{purchase.orderClassification ?? "—"}</span>
        ) : (
        <select
          className="rounded-md border border-gray-300 px-2 py-1 text-xs"
          value={purchase.orderClassification ?? ""}
          onChange={(e) =>
            updatePurchase.mutate({
              id: purchase.id,
              input: { orderClassification: e.target.value as "first_order" | "recurring" | "unknown" },
            })
          }
        >
          <option value="first_order">First order</option>
          <option value="recurring">Recurring</option>
          <option value="unknown">Unknown</option>
        </select>
        )}
      </td>
    </tr>
  );
}

function AddPurchaseForm({ customerId, onDone }: { customerId: string; onDone: () => void }) {
  const [form, setForm] = useState({ purchaseDate: "", orderNumber: "", productName: "", amountPaid: "" });
  const createPurchase = useCreatePurchase(customerId);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    createPurchase.mutate(form, { onSuccess: onDone });
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Date">
          <Input type="date" required value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })} />
        </Field>
        <Field label="Order #">
          <Input required value={form.orderNumber} onChange={(e) => setForm({ ...form, orderNumber: e.target.value })} />
        </Field>
        <Field label="Product">
          <Input required value={form.productName} onChange={(e) => setForm({ ...form, productName: e.target.value })} />
        </Field>
        <Field label="Amount">
          <Input
            required
            placeholder="49.99"
            value={form.amountPaid}
            onChange={(e) => setForm({ ...form, amountPaid: e.target.value })}
          />
        </Field>
        <div className="col-span-2 flex items-center gap-2 sm:col-span-4">
          <Button type="submit" disabled={createPurchase.isPending}>
            {createPurchase.isPending ? "Adding…" : "Add purchase"}
          </Button>
          <ErrorText>
            {createPurchase.isError
              ? createPurchase.error instanceof ApiError
                ? createPurchase.error.message
                : "Something went wrong."
              : null}
          </ErrorText>
        </div>
      </form>
    </Card>
  );
}
