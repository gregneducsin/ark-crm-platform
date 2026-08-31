import { useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "wouter";
import type { ConversationPersona, UnifiedConversationChannel, UnifiedMessage } from "@luma/shared";
import { useUnifiedConversationsList, useUnifiedConversationDetail, useClearAllNeedsAttention, useSendUnifiedStaffReply } from "../hooks/useUnifiedConversations";
import { Badge, Card, Button, Input } from "../components/ui";
import { UpcomingTriggerBanner } from "../components/UpcomingTriggerBanner";
import { CollapsibleCustomerNotes } from "../components/CustomerNotesCard";
import { ApiError } from "../hooks/useAuth";
import { formatTime, formatDate } from "../lib/formatTime";

const BOT_NAME: Record<ConversationPersona, string> = { sales: "Alexis", support: "Sophie" };
const PERSONA_LABEL: Record<ConversationPersona, string> = { sales: "Sales", support: "Support" };
const CHANNEL_LABEL: Record<UnifiedConversationChannel, string> = { sms: "SMS", email: "Email" };

const SENTIMENT_COLOR: Record<string, "green" | "gray" | "red"> = {
  positive: "green",
  neutral: "gray",
  negative: "red",
};

function SentimentBadge({ sentiment }: { sentiment: "positive" | "neutral" | "negative" | null }) {
  if (!sentiment) return null;
  return <Badge color={SENTIMENT_COLOR[sentiment]}>{sentiment}</Badge>;
}

/** Marks who actually wrote an outbound message — the bot vs a staff member typing into the reply box — so the timeline reads as one continuous conversation but staff can still tell AI from human, and which human, at a glance. */
function SenderBadge({ sentBy, staffEmail, botName }: { sentBy: "ai" | "staff" | null | undefined; staffEmail: string | null | undefined; botName: string }) {
  if (!sentBy) return null;
  const label = sentBy === "ai" ? botName : (staffEmail?.split("@")[0] ?? "Staff");
  return (
    <span className="text-[11px] font-medium text-gray-400" title={sentBy === "staff" && staffEmail ? staffEmail : undefined}>
      {label}
    </span>
  );
}

/** Which pipeline a message came from — the piece of context the old separate pages got for free from which tab you were on, now that everything's interleaved. */
function ThreadBadge({ persona, channel }: { persona: ConversationPersona; channel: UnifiedConversationChannel }) {
  return (
    <span className={"rounded px-1.5 py-0.5 text-[10px] font-medium uppercase " + (persona === "sales" ? "bg-ark-blue-50 text-ark-blue-600" : "bg-purple-50 text-purple-600")}>
      {PERSONA_LABEL[persona]} · {CHANNEL_LABEL[channel]}
    </span>
  );
}

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

type LeadSourceFilter = "all" | "abandoned_cart" | "meta_form";

const LEAD_SOURCE_FILTER_LABELS: Record<LeadSourceFilter, string> = {
  all: "All sources",
  abandoned_cart: "Abandoned cart",
  meta_form: "Meta leads",
};

/** Sales-only — support was never covered by this stat on the old Conversations tab either. */
function SalesResponseSummary() {
  const { data } = useUnifiedConversationsList();
  const stats = data?.salesStats;
  const ratePct = stats ? Math.round(stats.responseRate * 100) : null;

  return (
    <Card className="mb-4">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <p className="text-xs font-medium uppercase text-gray-400">Sales contacted</p>
          <p className="mt-1 text-2xl font-semibold text-ark-ink">{stats?.totalContacted ?? "…"}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-gray-400">Sales responded</p>
          <p className="mt-1 text-2xl font-semibold text-ark-ink">{stats?.totalResponded ?? "…"}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-gray-400">Response rate</p>
          <p className="mt-1 text-2xl font-semibold text-ark-ink">{ratePct === null ? "…" : `${ratePct}%`}</p>
        </div>
      </div>
      <p className="mt-2 text-xs text-gray-400">Sales (Alexis) leads only, each contact counted once regardless of channel or how many messages went back and forth.</p>
    </Card>
  );
}

function ConversationList({ selectedPersonId, onSelect }: { selectedPersonId: string | null; onSelect: (personId: string, firstName: string, lastName: string) => void }) {
  const { data, isLoading } = useUnifiedConversationsList();
  const [onlyNeedsAttention, setOnlyNeedsAttention] = useState(false);
  const [leadSourceFilter, setLeadSourceFilter] = useState<LeadSourceFilter>("all");
  const [search, setSearch] = useState("");

  const attentionCount = data?.conversations.filter((c) => c.needsAttention).length ?? 0;
  const visible = useMemo(() => {
    if (!data) return [];
    const term = search.trim().toLowerCase();
    return data.conversations.filter((c) => {
      if (onlyNeedsAttention && !c.needsAttention) return false;
      if (leadSourceFilter !== "all" && c.leadSource !== leadSourceFilter) return false;
      if (term && !`${c.firstName} ${c.lastName}`.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [data, onlyNeedsAttention, leadSourceFilter, search]);

  return (
    <Card className="flex h-[calc(100vh-268px)] flex-col overflow-hidden p-0">
      <div className="border-b border-gray-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ark-ink">Conversations</h2>
          {attentionCount > 0 && <Badge color="red">{attentionCount} need attention</Badge>}
        </div>
        <div className="mt-2 flex gap-1">
          <button
            onClick={() => setOnlyNeedsAttention(false)}
            className={"rounded px-2 py-1 text-xs font-medium " + (!onlyNeedsAttention ? "bg-ark-blue-600 text-white" : "bg-gray-100 text-gray-600")}
          >
            All
          </button>
          <button
            onClick={() => setOnlyNeedsAttention(true)}
            className={"rounded px-2 py-1 text-xs font-medium " + (onlyNeedsAttention ? "bg-ark-blue-600 text-white" : "bg-gray-100 text-gray-600")}
          >
            Needs attention
          </button>
        </div>
        <div className="mt-1 flex gap-1">
          {(Object.keys(LEAD_SOURCE_FILTER_LABELS) as LeadSourceFilter[]).map((key) => (
            <button
              key={key}
              onClick={() => setLeadSourceFilter(key)}
              className={"rounded px-2 py-1 text-xs font-medium " + (leadSourceFilter === key ? "bg-ark-blue-600 text-white" : "bg-gray-100 text-gray-600")}
            >
              {LEAD_SOURCE_FILTER_LABELS[key]}
            </button>
          ))}
        </div>
        <Input className="mt-2" placeholder="Search by name…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="flex-1 overflow-y-auto">
        {isLoading && <p className="p-4 text-sm text-gray-400">Loading…</p>}
        {data && visible.length === 0 && <p className="p-4 text-sm text-gray-400">Nothing matches these filters.</p>}
        {visible.map((c) => (
          <button
            key={c.personId}
            onClick={() => onSelect(c.personId, c.firstName, c.lastName)}
            className={"block w-full border-b border-gray-100 px-4 py-3 text-left hover:bg-gray-50 " + (selectedPersonId === c.personId ? "bg-ark-blue-50" : "")}
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-sm font-medium text-ark-ink">
                {c.needsAttention && <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-label="Needs attention" />}
                {c.firstName} {c.lastName}
              </span>
              <span className="text-xs text-gray-400">{relativeTime(c.lastMessageAt)}</span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <p className="flex-1 truncate text-xs text-gray-500">{c.lastMessagePreview ?? "No messages yet"}</p>
              {c.leadSource === "meta_form" && <Badge color="purple">Meta lead</Badge>}
              <SentimentBadge sentiment={c.lastSentiment} />
            </div>
            <div className="mt-1 flex gap-1">
              {c.hasSalesThread && <Badge color="blue">Sales</Badge>}
              {c.hasSupportThread && <Badge color="gray">Support</Badge>}
            </div>
          </button>
        ))}
      </div>
    </Card>
  );
}

interface ReplyTarget {
  persona: ConversationPersona;
  channel: UnifiedConversationChannel;
}

/** A staff-authored reply — sent through whichever real pipeline (persona x channel) is picked, and logged into that thread like any other outbound message. */
function StaffReplyBox({ personId, targets, defaultTarget }: { personId: string; targets: ReplyTarget[]; defaultTarget: ReplyTarget }) {
  const [target, setTarget] = useState<ReplyTarget>(defaultTarget);
  const [text, setText] = useState("");
  const sendReply = useSendUnifiedStaffReply();

  function handleSend() {
    const body = text.trim();
    if (!body || sendReply.isPending) return;
    sendReply.mutate(
      { personId, persona: target.persona, channel: target.channel, body },
      { onSuccess: (data) => { if (data.sent) setText(""); } },
    );
  }

  if (targets.length === 0) {
    return <p className="text-xs text-gray-400">No thread to reply on for this contact yet.</p>;
  }

  return (
    <div className="mt-2">
      {targets.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {targets.map((t) => {
            const active = t.persona === target.persona && t.channel === target.channel;
            return (
              <button
                key={`${t.persona}-${t.channel}`}
                onClick={() => setTarget(t)}
                className={"rounded px-2 py-1 text-[11px] font-medium " + (active ? "bg-ark-blue-600 text-white" : "bg-gray-100 text-gray-600")}
              >
                Reply as {BOT_NAME[t.persona]} ({CHANNEL_LABEL[t.channel]})
              </button>
            );
          })}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          className="flex-1"
          placeholder={target.channel === "email" ? "Reply as staff (email)…" : "Reply as staff…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={sendReply.isPending}
        />
        <Button onClick={handleSend} disabled={sendReply.isPending || !text.trim()}>
          {sendReply.isPending ? "Sending…" : "Send reply"}
        </Button>
      </div>
      {target.channel === "email" && (
        <p className="mt-1 text-[11px] text-gray-400">Sent as an email, greeted and signed off the same way an AI-drafted reply would be.</p>
      )}
      {sendReply.isSuccess && sendReply.data.sent === false && (
        <p className="mt-1 text-xs text-red-600">
          {sendReply.data.reason === "no_phone" && "No phone number on file — nothing was sent."}
          {sendReply.data.reason === "send_failed" && "Send failed — the message was logged, but nothing actually went out."}
        </p>
      )}
      {sendReply.isError && (
        <p className="mt-1 text-xs text-red-600">{sendReply.error instanceof ApiError ? sendReply.error.message : "Something went wrong."}</p>
      )}
    </div>
  );
}

type ChannelFilter = "all" | UnifiedConversationChannel;

const CHANNEL_FILTER_LABELS: Record<ChannelFilter, string> = { all: "All", sms: "SMS", email: "Email" };

function ConversationDetailPanel({ personId, firstName, lastName }: { personId: string; firstName: string; lastName: string }) {
  const { data, isLoading } = useUnifiedConversationDetail(personId);
  const clearAttention = useClearAllNeedsAttention();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");

  const channelsPresent = useMemo(() => new Set((data?.messages ?? []).map((m) => m.channel)), [data?.messages]);
  const visibleMessages = useMemo(
    () => (channelFilter === "all" ? (data?.messages ?? []) : (data?.messages ?? []).filter((m) => m.channel === channelFilter)),
    [data?.messages, channelFilter],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [visibleMessages.length]);

  // Reset back to "All" when switching contacts, so a filter picked for one
  // lead doesn't silently hide the other channel's messages for the next.
  useEffect(() => {
    setChannelFilter("all");
  }, [personId]);

  const header = (
    <div className="border-b border-gray-200 px-4 py-3">
      <p className="text-sm font-semibold text-ark-ink">
        {firstName} {lastName}
      </p>
    </div>
  );

  if (isLoading || !data) {
    return (
      <Card className="flex h-[calc(100vh-268px)] flex-col overflow-hidden p-0">
        {header}
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-gray-400">Loading conversation…</p>
        </div>
      </Card>
    );
  }

  const { customer, sales, support, messages, availableReplyTargets } = data;
  const needsAttention = Boolean(sales?.needsAttention || support?.needsAttention);
  const needsAttentionReason = [sales?.needsAttention ? sales.needsAttentionReason : null, support?.needsAttention ? support.needsAttentionReason : null]
    .filter((r): r is string => Boolean(r))
    .join(" | ");

  const lastMessage = messages.at(-1);
  const defaultTarget: ReplyTarget =
    (lastMessage && availableReplyTargets.find((t) => t.persona === lastMessage.persona && t.channel === lastMessage.channel)) ||
    availableReplyTargets[0] || { persona: "sales", channel: "sms" };

  return (
    <Card className="flex h-[calc(100vh-268px)] flex-col overflow-hidden p-0">
      <div className="border-b border-gray-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold text-ark-ink">
              {customer.firstName} {customer.lastName}
              {customer.hasQualifyingPurchase && <Badge color="green">Purchased</Badge>}
              {needsAttention && <Badge color="red">Needs attention</Badge>}
            </p>
            <p className="text-xs text-gray-400">
              {[customer.phone, customer.email].filter(Boolean).join(" · ") || "No contact info on file"}
            </p>
            <UpcomingTriggerBanner personId={customer.id} />
          </div>
          <div className="flex flex-wrap items-start justify-end gap-1">
            {sales?.leadSource === "meta_form" && <Badge color="purple">Meta lead</Badge>}
            {sales?.selectedProduct && <Badge color="blue">{sales.selectedProduct}</Badge>}
            {sales?.promoOffered && <Badge color="green">$20 promo offered</Badge>}
            {sales?.linkProvided && <Badge color="gray">link sent</Badge>}
            {sales?.linkProvided && (sales.intakeLinkClicked ? <Badge color="green">link clicked</Badge> : <Badge color="gray">link not clicked</Badge>)}
            {sales && sales.objectionStage > 0 && <Badge color="yellow">objection stage {sales.objectionStage}</Badge>}
            {support?.prescriptionWritten && <Badge color="blue">prescription written</Badge>}
            {support?.orderShipped && <Badge color="green">shipped{support.trackingNumber ? `: ${support.trackingNumber}` : ""}</Badge>}
            {support?.reviewRequested && <Badge color="gray">review requested</Badge>}
            {support?.reviewSentiment && <SentimentBadge sentiment={support.reviewSentiment} />}
          </div>
        </div>
        {needsAttention && (
          <div className="mt-2 rounded-md bg-red-50 px-3 py-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-red-700">{needsAttentionReason || "This conversation needs staff attention."}</p>
              <Button variant="secondary" onClick={() => clearAttention.mutate(personId)} disabled={clearAttention.isPending}>
                {clearAttention.isPending ? "Marking…" : "Mark reviewed"}
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="border-b border-gray-200 px-4 py-2">
        <CollapsibleCustomerNotes customerId={personId} />
      </div>

      {channelsPresent.size > 1 && (
        <div className="flex gap-1 border-b border-gray-200 px-4 py-2">
          {(Object.keys(CHANNEL_FILTER_LABELS) as ChannelFilter[]).map((key) => (
            <button
              key={key}
              onClick={() => setChannelFilter(key)}
              className={"rounded px-2 py-1 text-xs font-medium " + (channelFilter === key ? "bg-ark-blue-600 text-white" : "bg-gray-100 text-gray-600")}
            >
              {CHANNEL_FILTER_LABELS[key]}
            </button>
          ))}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {visibleMessages.length === 0 && (
          <p className="text-sm text-gray-400">{messages.length === 0 ? "No messages yet." : "No messages on this channel."}</p>
        )}
        {visibleMessages.map((m: UnifiedMessage, i) => {
          // A bare time ("6:16 PM") with no date reads identically whether
          // the next message came 20 minutes or 6 days later — this divider
          // makes the actual gap between sends visible without staff having
          // to hover/click each timestamp to check.
          const showDateDivider = i === 0 || formatDate(m.createdAt) !== formatDate(visibleMessages[i - 1].createdAt);
          return (
            <div key={`${m.persona}-${m.channel}-${m.id}`}>
              {showDateDivider && (
                <div className="my-3 flex items-center justify-center">
                  <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] font-medium text-gray-500">{formatDate(m.createdAt)}</span>
                </div>
              )}
              <div className={m.direction === "inbound" ? "text-left" : "text-right"}>
                <div className={"inline-flex max-w-[75%] flex-col gap-1 " + (m.direction === "inbound" ? "items-start" : "items-end")}>
                  <ThreadBadge persona={m.persona} channel={m.channel} />
                  {m.subject && <span className="px-1 text-[11px] font-medium text-gray-500">{m.subject}</span>}
                  <span
                    className={
                      m.direction === "inbound"
                        ? "inline-block whitespace-pre-wrap rounded-lg bg-gray-100 px-3 py-2 text-left text-sm text-gray-800"
                        : "inline-block whitespace-pre-wrap rounded-lg px-3 py-2 text-left text-sm text-white " +
                          (m.persona === "sales" ? "bg-ark-blue-600" : "bg-purple-600")
                    }
                  >
                    {m.body}
                  </span>
                  <div className="flex items-center gap-2 px-1">
                    {m.direction === "outbound" && <SenderBadge sentBy={m.sentBy} staffEmail={m.sentByStaffEmail} botName={BOT_NAME[m.persona]} />}
                    <span className="text-[11px] text-gray-400">{formatTime(m.createdAt)}</span>
                    <SentimentBadge sentiment={m.sentiment} />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-gray-200 p-3">
        <StaffReplyBox personId={personId} targets={availableReplyTargets} defaultTarget={defaultTarget} />
        <p className="mt-1 text-xs text-gray-400">You can also text or email the customer directly anytime.</p>
      </div>
    </Card>
  );
}

interface SelectedContact {
  personId: string;
  firstName: string;
  lastName: string;
}

export function ConversationsPage() {
  // CustomerDetailPage and NeedsAttentionPage link here as /conversations?personId=...
  const search = useSearch();
  const params = new URLSearchParams(search);
  const deepLinkPersonId = params.get("personId");
  const [selected, setSelected] = useState<SelectedContact | null>(null);
  const deepLinkResolved = useRef(false);

  const { data: listData } = useUnifiedConversationsList();
  useEffect(() => {
    if (!deepLinkPersonId || deepLinkResolved.current || selected !== null || !listData) return;
    const match = listData.conversations.find((c) => c.personId === deepLinkPersonId);
    if (match) {
      setSelected({ personId: match.personId, firstName: match.firstName, lastName: match.lastName });
      deepLinkResolved.current = true;
    }
  }, [deepLinkPersonId, listData, selected]);

  function handleSelect(personId: string, firstName: string, lastName: string) {
    deepLinkResolved.current = true;
    setSelected({ personId, firstName, lastName });
  }

  return (
    <div>
      <SalesResponseSummary />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="md:col-span-1">
          <ConversationList selectedPersonId={selected?.personId ?? null} onSelect={handleSelect} />
        </div>
        <div className="md:col-span-2">
          {selected ? (
            <ConversationDetailPanel personId={selected.personId} firstName={selected.firstName} lastName={selected.lastName} />
          ) : (
            <Card className="flex h-[calc(100vh-268px)] items-center justify-center">
              <p className="text-sm text-gray-400">Select a conversation to view it.</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
