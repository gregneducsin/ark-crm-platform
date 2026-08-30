import { useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "wouter";
import {
  useSupportConversationsList,
  useSupportConversationDetail,
  useClearSupportNeedsAttention,
  useSendStaffReply,
  type SupportConversationChannel,
} from "../hooks/useSupportConversations";
import { Badge, Card, Button, Input } from "../components/ui";
import { UpcomingTriggerBanner } from "../components/UpcomingTriggerBanner";
import { CollapsibleCustomerNotes } from "../components/CustomerNotesCard";
import { ApiError } from "../hooks/useAuth";
import { formatTime, formatDate } from "../lib/formatTime";

function ChannelToggle({ channel, onChange }: { channel: SupportConversationChannel; onChange: (c: SupportConversationChannel) => void }) {
  return (
    <div className="flex gap-1">
      {(["sms", "email"] as const).map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          className={"rounded px-2 py-1 text-xs font-medium uppercase " + (channel === c ? "bg-purple-600 text-white" : "bg-gray-100 text-gray-600")}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

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

function SupportConversationList({
  channel,
  onChannelChange,
  selectedPersonId,
  onSelect,
}: {
  channel: SupportConversationChannel;
  onChannelChange: (c: SupportConversationChannel) => void;
  selectedPersonId: string | null;
  onSelect: (personId: string, firstName: string, lastName: string) => void;
}) {
  const { data, isLoading } = useSupportConversationsList(channel);
  const [onlyNeedsAttention, setOnlyNeedsAttention] = useState(false);
  const [search, setSearch] = useState("");

  const attentionCount = data?.conversations.filter((c) => c.needsAttention).length ?? 0;
  const visible = useMemo(() => {
    if (!data) return [];
    const term = search.trim().toLowerCase();
    return data.conversations.filter((c) => {
      if (onlyNeedsAttention && !c.needsAttention) return false;
      if (term && !`${c.firstName} ${c.lastName}`.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [data, onlyNeedsAttention, search]);

  return (
    <Card className="flex h-[calc(100vh-180px)] flex-col overflow-hidden p-0">
      <div className="border-b border-gray-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Support</h2>
          <div className="flex items-center gap-2">
            {attentionCount > 0 && <Badge color="red">{attentionCount} need attention</Badge>}
            <ChannelToggle channel={channel} onChange={onChannelChange} />
          </div>
        </div>
        <div className="mt-2 flex gap-1">
          <button
            onClick={() => setOnlyNeedsAttention(false)}
            className={"rounded px-2 py-1 text-xs font-medium " + (!onlyNeedsAttention ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600")}
          >
            All
          </button>
          <button
            onClick={() => setOnlyNeedsAttention(true)}
            className={"rounded px-2 py-1 text-xs font-medium " + (onlyNeedsAttention ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600")}
          >
            Needs attention
          </button>
        </div>
        <Input
          className="mt-2"
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {isLoading && <p className="p-4 text-sm text-gray-400">Loading…</p>}
        {data && visible.length === 0 && (
          <p className="p-4 text-sm text-gray-400">
            {search.trim()
              ? "No conversations match that search."
              : onlyNeedsAttention
                ? "Nothing needs attention right now."
                : "No conversations yet."}
          </p>
        )}
        {visible.map((c) => (
          <button
            key={c.id}
            onClick={() => onSelect(c.personId, c.firstName, c.lastName)}
            className={
              "block w-full border-b border-gray-100 px-4 py-3 text-left hover:bg-gray-50 " + (selectedPersonId === c.personId ? "bg-blue-50" : "")
            }
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
                {c.needsAttention && <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-label="Needs attention" />}
                {c.firstName} {c.lastName}
              </span>
              <span className="text-xs text-gray-400">{relativeTime(c.lastMessageAt)}</span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <p className="flex-1 truncate text-xs text-gray-500">{c.lastMessagePreview ?? "No messages yet"}</p>
              <SentimentBadge sentiment={c.lastSentiment} />
            </div>
          </button>
        ))}
      </div>
    </Card>
  );
}

/** A staff-authored reply — sent through the real SMS or email provider (per channel) and logged into the conversation like any other outbound message. */
function StaffReplyBox({ conversationId, channel }: { conversationId: string; channel: SupportConversationChannel }) {
  const [text, setText] = useState("");
  const sendReply = useSendStaffReply();

  function handleSend() {
    const body = text.trim();
    if (!body || sendReply.isPending) return;
    sendReply.mutate(
      { conversationId, body, channel },
      { onSuccess: (data) => { if (data.sent) setText(""); } },
    );
  }

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <Input
          className="flex-1"
          placeholder={channel === "email" ? "Reply as staff (email)…" : "Reply as staff…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={sendReply.isPending}
        />
        <Button onClick={handleSend} disabled={sendReply.isPending || !text.trim()}>
          {sendReply.isPending ? "Sending…" : "Send reply"}
        </Button>
      </div>
      {channel === "email" && (
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

function SupportConversationDetailPanel({
  personId,
  firstName,
  lastName,
  channel,
  onChannelChange,
}: {
  personId: string;
  firstName: string;
  lastName: string;
  channel: SupportConversationChannel;
  onChannelChange: (c: SupportConversationChannel) => void;
}) {
  // The list for this channel is already being fetched (and polled) for the
  // left-hand list whenever that channel is the one being browsed — reusing
  // it here (React Query dedupes identical in-flight/cached queries) is how
  // we resolve "does this contact have a conversation on this channel" and
  // its conversationId without a dedicated lookup endpoint.
  const { data: listData, isLoading: listLoading } = useSupportConversationsList(channel);
  const summary = listData?.conversations.find((c) => c.personId === personId);
  const { data, isLoading: detailLoading } = useSupportConversationDetail(summary?.id ?? null, channel);
  const clearAttention = useClearSupportNeedsAttention();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [data?.messages.length]);

  const header = (
    <div className="border-b border-gray-200 px-4 py-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-900">
          {firstName} {lastName}
        </p>
        <ChannelToggle channel={channel} onChange={onChannelChange} />
      </div>
    </div>
  );

  if (listLoading) {
    return (
      <Card className="flex h-[calc(100vh-180px)] flex-col overflow-hidden p-0">
        {header}
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-gray-400">Loading…</p>
        </div>
      </Card>
    );
  }

  if (!summary) {
    return (
      <Card className="flex h-[calc(100vh-180px)] flex-col overflow-hidden p-0">
        {header}
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-gray-400">No {channel === "email" ? "email" : "text"} conversation for this contact yet.</p>
        </div>
      </Card>
    );
  }

  if (detailLoading || !data) {
    return (
      <Card className="flex h-[calc(100vh-180px)] flex-col overflow-hidden p-0">
        {header}
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-gray-400">Loading conversation…</p>
        </div>
      </Card>
    );
  }

  const { conversation, customer, messages } = data;

  return (
    <Card className="flex h-[calc(100vh-180px)] flex-col overflow-hidden p-0">
      <div className="border-b border-gray-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              {customer.firstName} {customer.lastName}
              {conversation.needsAttention && <Badge color="red">Needs attention</Badge>}
            </p>
            <p className="text-xs text-gray-400">
              {channel === "email" ? customer.email ?? "No email on file" : customer.phone ?? "No phone on file"}
            </p>
            <UpcomingTriggerBanner personId={conversation.personId} />
          </div>
          <div className="flex flex-wrap items-start justify-end gap-1">
            <ChannelToggle channel={channel} onChange={onChannelChange} />
            {conversation.prescriptionWritten && <Badge color="blue">prescription written</Badge>}
            {conversation.orderShipped && <Badge color="green">shipped{conversation.trackingNumber ? `: ${conversation.trackingNumber}` : ""}</Badge>}
            {conversation.reviewRequested && <Badge color="gray">review requested</Badge>}
            {conversation.reviewSentiment && <SentimentBadge sentiment={conversation.reviewSentiment} />}
          </div>
        </div>
        {conversation.needsAttention && (
          <div className="mt-2 rounded-md bg-red-50 px-3 py-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-red-700">
                {conversation.needsAttentionReason ?? "This conversation needs staff attention."}
              </p>
              <Button
                variant="secondary"
                onClick={() => clearAttention.mutate({ conversationId: conversation.id, channel })}
                disabled={clearAttention.isPending}
              >
                {clearAttention.isPending ? "Marking…" : "Mark reviewed"}
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="border-b border-gray-200 px-4 py-2">
        <CollapsibleCustomerNotes customerId={conversation.personId} />
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && <p className="text-sm text-gray-400">No messages yet.</p>}
        {messages.map((m, i) => {
          // A bare time ("6:16 PM") with no date reads identically whether
          // the next message came 20 minutes or 6 days later — this divider
          // makes the actual gap between sends visible without staff having
          // to hover/click each timestamp to check.
          const showDateDivider = i === 0 || formatDate(m.createdAt) !== formatDate(messages[i - 1].createdAt);
          return (
            <div key={m.id}>
              {showDateDivider && (
                <div className="my-3 flex items-center justify-center">
                  <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] font-medium text-gray-500">{formatDate(m.createdAt)}</span>
                </div>
              )}
              <div className={m.direction === "inbound" ? "text-left" : "text-right"}>
                <div className={"inline-flex max-w-[75%] flex-col gap-1 " + (m.direction === "inbound" ? "items-start" : "items-end")}>
                  {m.subject && <span className="px-1 text-[11px] font-medium text-gray-500">{m.subject}</span>}
                  <span
                    className={
                      m.direction === "inbound"
                        ? "inline-block whitespace-pre-wrap rounded-lg bg-gray-100 px-3 py-2 text-left text-sm text-gray-800"
                        : "inline-block whitespace-pre-wrap rounded-lg bg-purple-600 px-3 py-2 text-left text-sm text-white"
                    }
                  >
                    {m.body}
                  </span>
                  <div className="flex items-center gap-2 px-1">
                    {m.direction === "outbound" && <SenderBadge sentBy={m.sentBy} staffEmail={m.sentByStaffEmail} botName="Sophie" />}
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
        <StaffReplyBox conversationId={conversation.id} channel={channel} />
        <p className="mt-1 text-xs text-gray-400">
          {channel === "sms" ? "You can also text the patient directly anytime." : "You can also reply from your own email client anytime."}
        </p>
      </div>
    </Card>
  );
}

interface SelectedContact {
  personId: string;
  firstName: string;
  lastName: string;
  /** The detail panel's own channel — independent of the list's channel, so toggling it doesn't change what the list is browsing or lose the selection. */
  channel: SupportConversationChannel;
}

export function SupportPage() {
  // Lets NeedsAttentionPage link directly into the right channel tab (e.g. /support?channel=email).
  const search = useSearch();
  const params = new URLSearchParams(search);
  const initialChannel: SupportConversationChannel = params.get("channel") === "email" ? "email" : "sms";
  const deepLinkPersonId = params.get("personId");
  const [listChannel, setListChannel] = useState<SupportConversationChannel>(initialChannel);
  const [selected, setSelected] = useState<SelectedContact | null>(null);
  const deepLinkResolved = useRef(false);

  // CustomerDetailPage links here as /support?personId=... — find that
  // person's conversation once the list loads and select it. Keeps trying
  // across a manual list-channel toggle (the person may only exist on the
  // other channel) until it succeeds; a manual selection or lack of a
  // personId param disables this entirely.
  const { data: listData } = useSupportConversationsList(listChannel);
  useEffect(() => {
    if (!deepLinkPersonId || deepLinkResolved.current || selected !== null || !listData) return;
    const match = listData.conversations.find((c) => c.personId === deepLinkPersonId);
    if (match) {
      setSelected({ personId: match.personId, firstName: match.firstName, lastName: match.lastName, channel: listChannel });
      deepLinkResolved.current = true;
    }
  }, [deepLinkPersonId, listData, listChannel, selected]);

  function handleListChannelChange(c: SupportConversationChannel) {
    setListChannel(c);
    setSelected(null);
  }

  function handleSelect(personId: string, firstName: string, lastName: string) {
    deepLinkResolved.current = true;
    setSelected({ personId, firstName, lastName, channel: listChannel });
  }

  function handleDetailChannelChange(c: SupportConversationChannel) {
    setSelected((prev) => (prev ? { ...prev, channel: c } : prev));
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <div className="md:col-span-1">
        <SupportConversationList
          channel={listChannel}
          onChannelChange={handleListChannelChange}
          selectedPersonId={selected?.personId ?? null}
          onSelect={handleSelect}
        />
      </div>
      <div className="md:col-span-2">
        {selected ? (
          <SupportConversationDetailPanel
            personId={selected.personId}
            firstName={selected.firstName}
            lastName={selected.lastName}
            channel={selected.channel}
            onChannelChange={handleDetailChannelChange}
          />
        ) : (
          <Card className="flex h-[calc(100vh-180px)] items-center justify-center">
            <p className="text-sm text-gray-400">Select a conversation to view it.</p>
          </Card>
        )}
      </div>
    </div>
  );
}
