import { useState } from "react";
import { useCustomerNotes, useCreateCustomerNote } from "../hooks/useCustomers";
import { Button, Card, ErrorText } from "./ui";
import { ApiError, useCurrentUser } from "../hooks/useAuth";
import { formatDateTime } from "../lib/formatTime";

/**
 * Internal staff commentary — never shown to the customer. Append-only: no
 * edit or delete, matching every other activity log in this app. Both admin
 * and customer_service can add one — CS reps are the ones actually taking
 * the call/text and logging what happened, not just admins.
 */
export function CustomerNotesCard({ customerId }: { customerId: string }) {
  const { data: currentUser } = useCurrentUser();
  const canEdit = currentUser?.user?.role === "admin" || currentUser?.user?.role === "customer_service";
  const { data, isLoading } = useCustomerNotes(customerId);
  const [draft, setDraft] = useState("");
  const createNote = useCreateCustomerNote(customerId);

  function handleAdd() {
    const body = draft.trim();
    if (!body || createNote.isPending) return;
    createNote.mutate({ body }, { onSuccess: () => setDraft("") });
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-gray-900">Notes</h2>
      <p className="text-xs text-gray-500">Internal staff notes — never shown to the customer.</p>

      {canEdit && (
        <div className="mt-3">
          <textarea
            className="w-full rounded-md border border-gray-300 p-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            rows={2}
            placeholder="Add a note…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={createNote.isPending}
          />
          <div className="mt-2 flex items-center gap-2">
            <Button onClick={handleAdd} disabled={createNote.isPending || !draft.trim()}>
              {createNote.isPending ? "Adding…" : "Add note"}
            </Button>
            <ErrorText>
              {createNote.isError ? (createNote.error instanceof ApiError ? createNote.error.message : "Something went wrong.") : null}
            </ErrorText>
          </div>
        </div>
      )}

      <div className="mt-3 space-y-2">
        {isLoading && <p className="text-xs text-gray-400">Loading…</p>}
        {!isLoading && data?.notes.length === 0 && <p className="text-xs text-gray-400">No notes yet.</p>}
        {data?.notes.map((note) => (
          <div key={note.id} className="rounded-md border border-gray-100 px-3 py-2">
            <p className="whitespace-pre-wrap text-sm text-gray-800">{note.body}</p>
            <p className="mt-1 text-xs text-gray-400">
              {note.authorEmail} · {formatDateTime(note.createdAt)}
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Collapsed-by-default wrapper for the Conversations/Support detail panels — the message thread is the primary content there, so notes stay out of the way until a rep opens them. */
export function CollapsibleCustomerNotes({ customerId }: { customerId: string }) {
  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-xs font-medium text-gray-500 hover:text-gray-700">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block transition-transform group-open:rotate-90">▶</span>
          Notes
        </span>
      </summary>
      <div className="mt-2">
        <CustomerNotesCard customerId={customerId} />
      </div>
    </details>
  );
}
