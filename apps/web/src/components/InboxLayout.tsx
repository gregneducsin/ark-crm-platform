import { type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useNeedsAttentionList } from "../hooks/useNeedsAttention";
import { useUnmatchedEmailsList } from "../hooks/useUnmatchedEmails";
import { useUnmatchedSmsList } from "../hooks/useUnmatchedSms";
import { Badge } from "./ui";

/**
 * Thin sub-nav shared by every page under /inbox. Needs Attention (existing
 * customer conversations Alexis/Sophie flagged for review) and Unmatched
 * Contacts (inbound messages from senders who don't match any customer)
 * are different kinds of triage queue with unrelated data models — this
 * only groups them under one top-level nav slot, same pattern as
 * AdminLayout, not a merge of their content.
 */
export function InboxLayout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { data: needsAttentionData } = useNeedsAttentionList();
  const needsAttentionCount = needsAttentionData?.items.length ?? 0;
  const { data: unmatchedEmailsData } = useUnmatchedEmailsList();
  const { data: unmatchedSmsData } = useUnmatchedSmsList();
  const unmatchedContactsCount =
    (unmatchedEmailsData?.items.filter((i) => i.status === "needs_review").length ?? 0) +
    (unmatchedSmsData?.items.filter((i) => i.status === "needs_review").length ?? 0);

  const subNav: readonly { href: string; label: string; count: number }[] = [
    { href: "/inbox/needs-attention", label: "Needs Attention", count: needsAttentionCount },
    { href: "/inbox/unmatched-contacts", label: "Unmatched Contacts", count: unmatchedContactsCount },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-gray-200 pb-2">
        {subNav.map((item) => {
          const active = location === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={"flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors " + (active ? "bg-ark-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-ark-surface")}
            >
              {item.label}
              {item.count > 0 && <Badge color={active ? "gray" : "red"}>{item.count}</Badge>}
            </Link>
          );
        })}
      </div>
      {children}
    </div>
  );
}
