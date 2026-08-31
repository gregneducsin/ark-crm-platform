import { useState } from "react";
import { AI_DIDNT_UNDERSTAND_REASON, type NeedsAttentionItem, type NeedsAttentionChannel, type NeedsAttentionPersona } from "@luma/shared";
import { useNeedsAttentionList, useNeedsAttentionMessages, useClearNeedsAttentionItem } from "../hooks/useNeedsAttention";
import { Badge, Card, Button } from "../components/ui";
import { formatDate, formatDateTime } from "../lib/formatTime";

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return formatDate(iso);
}

const CHANNEL_LABEL: Record<NeedsAttentionChannel, string> = { sms: "SMS", email: "Email" };
const PERSONA_LABEL: Record<NeedsAttentionPersona, string> = { alexis: "Alexis", sophie: "Sophie" };

function ItemMessages({ item }: { item: NeedsAttentionItem }) {
  const { data, isLoading } = useNeedsAttentionMessages(item.channel, item.persona, item.conversationId);

  if (isLoading || !data) return <p className="px-4 pb-3 text-xs text-gray-400">Loading recent messages…</p>;
  if (data.messages.length === 0) return <p className="px-4 pb-3 text-xs text-gray-400">No messages yet.</p>;

  return (
    <div className="space-y-2 px-4 pb-3">
      {data.messages.map((m) => (
        <div key={m.id} className={m.direction === "inbound" ? "text-left" : "text-right"}>
          <div className={"inline-block max-w-[85%] rounded-lg px-3 py-2 text-left text-xs " + (m.direction === "inbound" ? "bg-gray-100 text-gray-800" : "bg-ark-blue-600 text-white")}>
            {m.subject && <p className="mb-0.5 font-semibold">{m.subject}</p>}
            <p className="whitespace-pre-wrap">{m.body}</p>
          </div>
          <p className="mt-0.5 text-[11px] text-gray-400">{formatDateTime(m.createdAt)}</p>
        </div>
      ))}
    </div>
  );
}

function NeedsAttentionRow({ item }: { item: NeedsAttentionItem }) {
  const [expanded, setExpanded] = useState(false);
  const clearItem = useClearNeedsAttentionItem();

  return (
    <Card className="p-0">
      <button onClick={() => setExpanded((e) => !e)} className="block w-full px-4 py-3 text-left hover:bg-gray-50">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm font-medium text-ark-ink">
            <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-label="Needs attention" />
            {item.firstName} {item.lastName}
            <Badge color={item.channel === "sms" ? "blue" : "purple"}>{CHANNEL_LABEL[item.channel]}</Badge>
            <Badge color="gray">{PERSONA_LABEL[item.persona]}</Badge>
          </span>
          <span className="text-xs text-gray-400">{relativeTime(item.lastMessageAt)}</span>
        </div>
        <p className="mt-1 truncate text-xs text-gray-500">{item.lastMessagePreview ?? "No messages yet"}</p>
        {item.reason && <p className="mt-0.5 truncate text-xs font-medium text-red-600">{item.reason}</p>}
      </button>
      {expanded && (
        <div className="border-t border-gray-100">
          <ItemMessages item={item} />
          <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2">
            <a href={`/conversations?personId=${item.personId}`} className="text-xs font-medium text-ark-blue-600 hover:underline">
              Open full thread to reply →
            </a>
            <Button
              variant="secondary"
              onClick={() => clearItem.mutate({ channel: item.channel, persona: item.persona, conversationId: item.conversationId })}
              disabled={clearItem.isPending}
            >
              {clearItem.isPending ? "Marking…" : "Mark reviewed"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export function NeedsAttentionPage() {
  const { data, isLoading } = useNeedsAttentionList();
  const [onlyAiDidntUnderstand, setOnlyAiDidntUnderstand] = useState(false);

  const aiDidntUnderstandCount = data?.items.filter((i) => i.reason === AI_DIDNT_UNDERSTAND_REASON).length ?? 0;
  const visibleItems = onlyAiDidntUnderstand ? (data?.items.filter((i) => i.reason === AI_DIDNT_UNDERSTAND_REASON) ?? []) : (data?.items ?? []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ark-ink">Needs Attention</h1>
        {data && <p className="text-sm text-gray-500">{data.items.length} flagged across SMS and email</p>}
      </div>
      <p className="text-xs text-gray-400">
        Every conversation Alexis or Sophie flagged for staff review — a safety-relevant reply, a rejected guardrail turn, or a failed link/send that
        needs a human follow-up — across both SMS and email, in one place. Click a row to preview recent messages; use the full conversation page to
        actually reply.
      </p>

      {aiDidntUnderstandCount > 0 && (
        <button
          onClick={() => setOnlyAiDidntUnderstand((v) => !v)}
          className={
            "text-sm font-medium underline decoration-dotted underline-offset-2 " +
            (onlyAiDidntUnderstand ? "text-red-700" : "text-red-600 hover:text-red-700")
          }
        >
          {onlyAiDidntUnderstand ? `← Showing only what the AI didn't understand (${aiDidntUnderstandCount})` : `${aiDidntUnderstandCount} the AI didn't understand →`}
        </button>
      )}

      {isLoading && <p className="text-sm text-gray-400">Loading…</p>}
      {data && data.items.length === 0 && (
        <Card>
          <p className="text-sm text-gray-500">Nothing needs attention right now.</p>
        </Card>
      )}
      {data && data.items.length > 0 && visibleItems.length === 0 && (
        <Card>
          <p className="text-sm text-gray-500">Nothing in this filter right now.</p>
        </Card>
      )}
      <div className="space-y-2">
        {visibleItems.map((item) => (
          <NeedsAttentionRow key={`${item.channel}-${item.persona}-${item.conversationId}`} item={item} />
        ))}
      </div>
    </div>
  );
}
