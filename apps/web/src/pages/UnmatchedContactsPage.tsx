import { useState } from "react";
import type { UnmatchedEmailThreadSummary, UnmatchedSmsThreadSummary } from "@luma/shared";
import { useUnmatchedEmailsList, useUnmatchedEmailThread, useSendUnmatchedEmailReply, useDismissUnmatchedEmail } from "../hooks/useUnmatchedEmails";
import { useUnmatchedSmsList, useUnmatchedSmsThread, useSendUnmatchedSmsReply, useDismissUnmatchedSms } from "../hooks/useUnmatchedSms";
import { Badge, Card, Button } from "../components/ui";
import { ApiError } from "../hooks/useAuth";
import { formatDateTime } from "../lib/formatTime";

const INTENT_LABEL: Record<string, string> = {
  new_lead_interest: "New lead interest",
  existing_customer_support: "Support question",
  spam_or_irrelevant: "Spam / irrelevant",
  other: "Other",
};

const INTENT_COLOR: Record<string, "green" | "blue" | "gray" | "yellow"> = {
  new_lead_interest: "green",
  existing_customer_support: "blue",
  spam_or_irrelevant: "gray",
  other: "yellow",
};

const CONFIDENCE_COLOR: Record<string, "green" | "yellow" | "gray"> = { high: "green", medium: "yellow", low: "gray" };

/** Merges an email thread and an SMS thread into one shape the combined list renders — the two channels' underlying data (fromAddress/subject vs fromPhone/collectedEmail) stay separate below this point, keyed off `channel`. */
type CombinedThread = {
  readonly channel: "email" | "sms";
  readonly id: string;
  readonly contact: string;
  readonly contactLabel: string;
  readonly aiIntent: string | null;
  readonly aiSummary: string | null;
  readonly suggestedMatchCustomerId: string | null;
  readonly suggestedMatchConfidence: "high" | "medium" | "low" | null;
  readonly suggestedReply: string | null;
  readonly linkedCustomerId: string | null;
  readonly status: "needs_review" | "replied" | "dismissed";
  readonly repliedAt: string | null;
  readonly createdAt: string;
  readonly lastMessageAt: string | null;
  readonly lastMessagePreview: string | null;
};

function fromEmail(t: UnmatchedEmailThreadSummary): CombinedThread {
  return {
    channel: "email",
    id: t.id,
    contact: t.fromAddress,
    contactLabel: t.fromName ? `${t.fromName} <${t.fromAddress}>` : t.fromAddress,
    aiIntent: t.aiIntent,
    aiSummary: t.aiSummary,
    suggestedMatchCustomerId: t.suggestedMatchCustomerId,
    suggestedMatchConfidence: t.suggestedMatchConfidence,
    suggestedReply: t.suggestedReply,
    linkedCustomerId: t.linkedCustomerId,
    status: t.status,
    repliedAt: t.repliedAt,
    createdAt: t.createdAt,
    lastMessageAt: t.lastMessageAt,
    lastMessagePreview: t.lastMessagePreview,
  };
}

function fromSms(t: UnmatchedSmsThreadSummary): CombinedThread {
  return {
    channel: "sms",
    id: t.id,
    contact: t.fromPhone,
    contactLabel: [t.fromName ? `${t.fromName} (${t.fromPhone})` : t.fromPhone, t.collectedEmail].filter(Boolean).join(" · "),
    aiIntent: t.aiIntent,
    aiSummary: t.aiSummary,
    suggestedMatchCustomerId: t.suggestedMatchCustomerId,
    suggestedMatchConfidence: t.suggestedMatchConfidence,
    suggestedReply: t.suggestedReply,
    linkedCustomerId: t.linkedCustomerId,
    status: t.status,
    repliedAt: t.repliedAt,
    createdAt: t.createdAt,
    lastMessageAt: t.lastMessageAt,
    lastMessagePreview: t.lastMessagePreview,
  };
}

function ThreadMessages({ channel, threadId }: { channel: "email" | "sms"; threadId: string }) {
  const emailDetail = useUnmatchedEmailThread(channel === "email" ? threadId : null);
  const smsDetail = useUnmatchedSmsThread(channel === "sms" ? threadId : null);
  const { data, isLoading } = channel === "email" ? emailDetail : smsDetail;

  if (isLoading || !data) return <p className="px-4 pb-3 text-xs text-gray-400">Loading messages…</p>;

  return (
    <div className="space-y-2 px-4 pb-3">
      {data.messages.map((m) => (
        <div key={m.id} className={m.direction === "inbound" ? "text-left" : "text-right"}>
          <div className={"inline-block max-w-[85%] rounded-lg px-3 py-2 text-left text-xs " + (m.direction === "inbound" ? "bg-gray-100 text-gray-800" : "bg-ark-blue-600 text-white")}>
            {"subject" in m && <p className="mb-0.5 font-semibold">{m.subject}</p>}
            <p className="whitespace-pre-wrap">{m.body}</p>
          </div>
          <p className="mt-0.5 text-[11px] text-gray-400">{formatDateTime(m.createdAt)}</p>
        </div>
      ))}
    </div>
  );
}

function ThreadRow({
  thread,
  selected,
  onToggleSelect,
}: {
  thread: CombinedThread;
  /** Only threads awaiting review are selectable for bulk-dismiss — null hides the checkbox entirely for replied/dismissed rows. */
  selected: boolean;
  onToggleSelect: (() => void) | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(thread.suggestedReply ?? "");

  // Both channels' mutation hooks are called unconditionally (rules of
  // hooks) — which one actually gets used is decided per-click below, not
  // by conditionally calling one or the other.
  const sendEmailReply = useSendUnmatchedEmailReply();
  const sendSmsReply = useSendUnmatchedSmsReply();
  const dismissEmail = useDismissUnmatchedEmail();
  const dismissSms = useDismissUnmatchedSms();
  const sendReply = thread.channel === "email" ? sendEmailReply : sendSmsReply;
  const dismiss = thread.channel === "email" ? dismissEmail : dismissSms;

  function handleSend() {
    const body = draft.trim();
    if (!body || sendReply.isPending) return;
    sendReply.mutate({ id: thread.id, body });
  }

  return (
    <Card className="p-0">
      <div className="flex items-center">
        {onToggleSelect && (
          <label className="flex items-center pl-3" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              className="h-4 w-4 rounded border-gray-300 text-ark-blue-600 focus:ring-ark-blue-500"
              aria-label={`Select ${thread.contactLabel}`}
            />
          </label>
        )}
        <button onClick={() => setExpanded((e) => !e)} className="block min-w-0 flex-1 px-4 py-3 text-left hover:bg-gray-50">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-medium text-ark-ink">
              <Badge color={thread.channel === "email" ? "blue" : "green"}>{thread.channel === "email" ? "Email" : "Text"}</Badge>
              {thread.contactLabel}
              {thread.aiIntent && <Badge color={INTENT_COLOR[thread.aiIntent] ?? "gray"}>{INTENT_LABEL[thread.aiIntent] ?? thread.aiIntent}</Badge>}
              {thread.linkedCustomerId && <Badge color="green">Lead created</Badge>}
              {thread.status !== "needs_review" && <Badge color={thread.status === "replied" ? "green" : "gray"}>{thread.status}</Badge>}
            </span>
            <span className="text-xs text-gray-400">{formatDateTime(thread.lastMessageAt ?? thread.createdAt)}</span>
          </div>
          {thread.aiSummary && <p className="mt-1 truncate text-xs text-gray-400">{thread.aiSummary}</p>}
          <p className="mt-1 truncate text-xs text-gray-500">{thread.lastMessagePreview ?? "No messages yet"}</p>
        </button>
      </div>
      {expanded && (
        <div className="space-y-3 border-t border-gray-100">
          <div className="px-4 pt-3">
            <p className="text-xs font-medium text-gray-400">From</p>
            <p className="text-sm text-gray-800">{thread.contactLabel}</p>
          </div>

          <ThreadMessages channel={thread.channel} threadId={thread.id} />

          {thread.linkedCustomerId && (
            <div className="mx-4 rounded-md bg-green-50 px-3 py-2">
              <p className="text-xs text-green-800">
                A new lead was created for this sender, and this message was handed straight to Alexis's real pipeline — she's already replied. See{" "}
                <a href={`/customers/${thread.linkedCustomerId}`} className="font-medium underline">
                  their customer record
                </a>{" "}
                or the Conversations tab for that reply. Every {thread.channel === "email" ? "email" : "text"} from this {thread.channel === "email" ? "address" : "number"} from now on
                routes through Alexis automatically, same as any other lead.
              </p>
            </div>
          )}

          {thread.suggestedMatchCustomerId && !thread.linkedCustomerId && (
            <div className="mx-4 rounded-md bg-yellow-50 px-3 py-2">
              <p className="text-xs text-yellow-800">
                Possibly an existing customer ({thread.suggestedMatchConfidence && (
                  <Badge color={CONFIDENCE_COLOR[thread.suggestedMatchConfidence]}>{thread.suggestedMatchConfidence} confidence</Badge>
                )}
                ) — not linked automatically. Confirm in{" "}
                <a href={`/customers/${thread.suggestedMatchCustomerId}`} className="font-medium underline">
                  their customer record
                </a>{" "}
                before treating this as their thread.
              </p>
            </div>
          )}

          {thread.status === "needs_review" && (
            <div className="px-4 pb-3">
              <p className="mb-1 text-xs font-medium text-gray-400">
                {thread.suggestedReply ? "Claude's suggested reply — review and edit before sending:" : "No suggested reply — write one, or dismiss:"}
              </p>
              <textarea
                className="w-full rounded-md border border-gray-300 p-2 text-sm focus:border-ark-blue-500 focus:outline-none focus:ring-1 focus:ring-ark-blue-500"
                rows={4}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={sendReply.isPending}
              />
              <div className="mt-2 flex items-center gap-2">
                <Button onClick={handleSend} disabled={sendReply.isPending || !draft.trim()}>
                  {sendReply.isPending ? "Sending…" : "Send reply"}
                </Button>
                <Button variant="secondary" onClick={() => dismiss.mutate(thread.id)} disabled={dismiss.isPending}>
                  {dismiss.isPending ? "Dismissing…" : "Dismiss"}
                </Button>
              </div>
              {sendReply.isSuccess && sendReply.data.sent === false && <p className="mt-1 text-xs text-red-600">Send failed — nothing went out. Try again.</p>}
              {sendReply.isError && <p className="mt-1 text-xs text-red-600">{sendReply.error instanceof ApiError ? sendReply.error.message : "Something went wrong."}</p>}
            </div>
          )}
          {thread.status === "replied" && thread.repliedAt && <p className="px-4 pb-3 text-xs text-gray-400">Replied {formatDateTime(thread.repliedAt)}.</p>}
        </div>
      )}
    </Card>
  );
}

export function UnmatchedContactsPage() {
  const { data: emailData, isLoading: emailLoading } = useUnmatchedEmailsList();
  const { data: smsData, isLoading: smsLoading } = useUnmatchedSmsList();
  const isLoading = emailLoading || smsLoading;
  const [channel, setChannel] = useState<"all" | "email" | "sms">("all");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [isBulkDismissing, setIsBulkDismissing] = useState(false);
  const dismissEmailBulk = useDismissUnmatchedEmail();
  const dismissSmsBulk = useDismissUnmatchedSms();

  function changeChannel(next: "all" | "email" | "sms") {
    setChannel(next);
    setSelectedKeys(new Set());
  }

  const all: CombinedThread[] = [...(emailData?.items.map(fromEmail) ?? []), ...(smsData?.items.map(fromSms) ?? [])].sort(
    (a, b) => new Date(b.lastMessageAt ?? b.createdAt).getTime() - new Date(a.lastMessageAt ?? a.createdAt).getTime(),
  );
  const combined = channel === "all" ? all : all.filter((t) => t.channel === channel);
  const needsReview = combined.filter((i) => i.status === "needs_review");
  const resolved = combined.filter((i) => i.status !== "needs_review");
  const allNeedsReviewCount = all.filter((i) => i.status === "needs_review").length;
  const emailNeedsReviewCount = all.filter((i) => i.channel === "email" && i.status === "needs_review").length;
  const smsNeedsReviewCount = all.filter((i) => i.channel === "sms" && i.status === "needs_review").length;

  const needsReviewKeys = needsReview.map((t) => `${t.channel}-${t.id}`);
  const allSelected = needsReviewKeys.length > 0 && needsReviewKeys.every((k) => selectedKeys.has(k));

  function toggleSelectAll() {
    setSelectedKeys(allSelected ? new Set() : new Set(needsReviewKeys));
  }

  function toggleSelectOne(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleBulkDismiss() {
    const targets = needsReview.filter((t) => selectedKeys.has(`${t.channel}-${t.id}`));
    if (targets.length === 0 || isBulkDismissing) return;
    setIsBulkDismissing(true);
    try {
      await Promise.allSettled(targets.map((t) => (t.channel === "email" ? dismissEmailBulk.mutateAsync(t.id) : dismissSmsBulk.mutateAsync(t.id))));
    } finally {
      setIsBulkDismissing(false);
      setSelectedKeys(new Set());
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ark-ink">Unmatched Contacts</h1>
        {!isLoading && <p className="text-sm text-gray-500">{needsReview.length} awaiting review</p>}
      </div>

      <div className="flex items-center gap-1 rounded-md border border-gray-200 bg-white p-1 text-sm w-fit">
        {(
          [
            { value: "all", label: "All", count: allNeedsReviewCount },
            { value: "email", label: "Email", count: emailNeedsReviewCount },
            { value: "sms", label: "Text", count: smsNeedsReviewCount },
          ] as const
        ).map((opt) => (
          <button
            key={opt.value}
            onClick={() => changeChannel(opt.value)}
            className={
              "flex items-center gap-1.5 rounded px-3 py-1 font-medium " +
              (channel === opt.value ? "bg-ark-blue-600 text-white" : "text-gray-600 hover:bg-gray-50")
            }
          >
            {opt.label}
            {opt.count > 0 && <Badge color={channel === opt.value ? "gray" : "yellow"}>{opt.count}</Badge>}
          </button>
        ))}
      </div>

      <p className="text-xs text-gray-400">
        Inbound email and text messages from an address or phone number that doesn't match any customer record, one thread per sender, combined
        here regardless of channel. Replies are auto-sent by default: a fixed acknowledgment goes out on the first message (asking for their
        name, and for texts, their email next), and Claude's own drafted reply goes out on every message after that. Threads only land here for
        review when Claude flags genuine uncertainty (or an individualized medical/suitability question), or when the sender looks like a
        possible match to an existing customer, or claims to already have an account — those never auto-link or auto-send. Once a name and,
        for texts, a real-looking email are known and Claude is confident it's a genuine new lead, a lead is created automatically and the
        message is handed straight to Alexis's real pipeline — she takes it from there, same as any other lead.
      </p>

      {isLoading && <p className="text-sm text-gray-400">Loading…</p>}
      {!isLoading && combined.length === 0 && (
        <Card>
          <p className="text-sm text-gray-500">Nothing here right now.</p>
        </Card>
      )}

      {needsReview.length > 0 && (
        <div className="flex items-center gap-3 rounded-md border border-gray-200 bg-white px-3 py-2">
          <label className="flex items-center gap-2 text-xs font-medium text-gray-600">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleSelectAll}
              className="h-4 w-4 rounded border-gray-300 text-ark-blue-600 focus:ring-ark-blue-500"
            />
            Select all
          </label>
          {selectedKeys.size > 0 && (
            <>
              <span className="text-xs text-gray-400">{selectedKeys.size} selected</span>
              <Button variant="secondary" onClick={handleBulkDismiss} disabled={isBulkDismissing}>
                {isBulkDismissing ? "Dismissing…" : `Dismiss ${selectedKeys.size}`}
              </Button>
            </>
          )}
        </div>
      )}

      <div className="space-y-2">
        {needsReview.map((thread) => {
          const key = `${thread.channel}-${thread.id}`;
          return <ThreadRow key={key} thread={thread} selected={selectedKeys.has(key)} onToggleSelect={() => toggleSelectOne(key)} />;
        })}
      </div>

      {resolved.length > 0 && (
        <details className="text-sm text-gray-500">
          <summary className="cursor-pointer text-xs font-medium text-gray-400">{resolved.length} replied or dismissed</summary>
          <div className="mt-2 space-y-2">
            {resolved.map((thread) => (
              <ThreadRow key={`${thread.channel}-${thread.id}`} thread={thread} selected={false} onToggleSelect={null} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
