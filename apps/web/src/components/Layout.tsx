import { type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import clsx from "clsx";
import type { AuthUser } from "@luma/shared";
import { useCurrentUser, useLogout } from "../hooks/useAuth";
import { useNeedsAttentionList } from "../hooks/useNeedsAttention";
import { useUnmatchedEmailsList } from "../hooks/useUnmatchedEmails";
import { useUnmatchedSmsList } from "../hooks/useUnmatchedSms";
import { Button, Badge } from "./ui";
import { AiAssistantWidget } from "./AiAssistantWidget";

const NAV_ITEMS: readonly { href: string; label: string; roles: readonly AuthUser["role"][] }[] = [
  { href: "/", label: "Dashboard", roles: ["admin", "manager", "customer_service"] },
  { href: "/inbox", label: "Inbox", roles: ["admin", "customer_service"] },
  { href: "/customers", label: "Leads", roles: ["admin", "manager"] },
  { href: "/orders", label: "Orders", roles: ["admin", "manager"] },
  { href: "/failed-payments", label: "Failed Payments", roles: ["admin", "manager"] },
  { href: "/questionnaires", label: "Questionnaires", roles: ["admin"] },
  { href: "/conversations", label: "Conversations", roles: ["admin", "customer_service"] },
  { href: "/reporting", label: "Reporting", roles: ["admin"] },
  { href: "/admin", label: "Admin", roles: ["admin", "manager"] },
  { href: "/payroll/employees", label: "Payroll", roles: ["admin", "manager"] },
  { href: "/users", label: "Users", roles: ["admin"] },
];

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { data } = useCurrentUser();
  const logout = useLogout();
  const role = data?.user?.role;
  const canSeeNeedsAttention = role === "admin" || role === "customer_service";
  const { data: needsAttentionData } = useNeedsAttentionList(canSeeNeedsAttention);
  const needsAttentionCount = needsAttentionData?.items.length ?? 0;
  const { data: unmatchedEmailsData } = useUnmatchedEmailsList(canSeeNeedsAttention);
  const { data: unmatchedSmsData } = useUnmatchedSmsList(canSeeNeedsAttention);
  const unmatchedContactsCount =
    (unmatchedEmailsData?.items.filter((i) => i.status === "needs_review").length ?? 0) +
    (unmatchedSmsData?.items.filter((i) => i.status === "needs_review").length ?? 0);
  const visibleNavItems = NAV_ITEMS.filter((item) => !role || item.roles.includes(role));

  return (
    <div className="min-h-screen bg-ark-surface">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-[1800px] items-center justify-between px-4 py-3">
          <nav className="flex items-center gap-1">
            <span className="mr-3 text-base font-extrabold tracking-tight text-ark-ink">Ark Health</span>
            {visibleNavItems.map((item) => {
              const isActive =
                location === item.href ||
                (item.href === "/payroll/employees" && location.startsWith("/payroll")) ||
                (item.href === "/inbox" && location.startsWith("/inbox"));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={clsx(
                    "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors",
                    isActive ? "bg-ark-blue-50 text-ark-blue-700" : "text-gray-600 hover:bg-ark-surface hover:text-ark-ink",
                  )}
                >
                  {item.label}
                  {item.href === "/inbox" && needsAttentionCount + unmatchedContactsCount > 0 && <Badge color="red">{needsAttentionCount + unmatchedContactsCount}</Badge>}
                </Link>
              );
            })}
          </nav>
          <div className="flex items-center gap-3">
            {data?.user && <span className="text-sm text-gray-500">{data.user.email}</span>}
            <Button variant="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
              Log out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1800px] px-4 py-6">{children}</main>
      {role === "admin" && <AiAssistantWidget />}
    </div>
  );
}
