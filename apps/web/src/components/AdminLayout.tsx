import { type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useCurrentUser } from "../hooks/useAuth";

const ADMIN_SUB_NAV: readonly { href: string; label: string; adminOnly: boolean }[] = [
  { href: "/admin/webhook-log", label: "Webhook Log", adminOnly: false },
  { href: "/admin/marketing-cpa", label: "Marketing CPA", adminOnly: true },
];

/** Thin sub-nav shared by every page under /admin — Webhook Log and Marketing CPA are unrelated tools, just both operator-only, so this only groups them under one top-level nav slot rather than merging their content. */
export function AdminLayout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { data } = useCurrentUser();
  const role = data?.user?.role;
  const visible = ADMIN_SUB_NAV.filter((item) => !item.adminOnly || role === "admin");

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-gray-200 pb-2">
        {visible.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={"rounded px-3 py-1.5 text-sm font-medium " + (location === item.href ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200")}
          >
            {item.label}
          </Link>
        ))}
      </div>
      {children}
    </div>
  );
}
