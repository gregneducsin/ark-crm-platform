import { Link, useLocation } from "wouter";

const TABS = [
  { href: "/payroll/employees", label: "Employees" },
  { href: "/payroll/weeks", label: "Payroll Weeks" },
] as const;

/** Employees and Payroll Weeks share one top-nav tab — this sub-nav is how staff switch between the two once inside it. */
export function PayrollSubNav() {
  const [location] = useLocation();
  return (
    <div className="flex gap-1">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={"rounded px-3 py-1.5 text-sm font-medium " + (location.startsWith(t.href) ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200")}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
