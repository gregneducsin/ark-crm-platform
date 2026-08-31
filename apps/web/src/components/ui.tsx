import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";

export function Button({ className, variant = "primary", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" }) {
  return (
    <button
      className={clsx(
        "rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-ark-blue-600 text-white shadow-sm hover:bg-ark-blue-700 focus-visible:ring-ark-blue-500",
        variant === "secondary" && "border border-gray-200 bg-white text-ark-ink hover:bg-ark-surface focus-visible:ring-ark-blue-500",
        variant === "danger" && "bg-red-600 text-white shadow-sm hover:bg-red-700 focus-visible:ring-red-500",
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={clsx(
        "w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-ark-ink placeholder:text-gray-400 focus:border-ark-blue-500 focus:outline-none focus:ring-1 focus:ring-ark-blue-500",
        className,
      )}
      {...props}
    />
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("rounded-xl border border-gray-200/70 bg-white p-4 shadow-sm", className)}>{children}</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</span>
      {children}
    </label>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="mt-1 text-sm text-red-600">{children}</p>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ark-ink/40 px-4">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ark-ink">{title}</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-ark-ink" aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Badge({ children, color = "gray" }: { children: ReactNode; color?: "gray" | "green" | "yellow" | "red" | "blue" | "purple" }) {
  const colors: Record<string, string> = {
    gray: "bg-gray-100 text-gray-700",
    green: "bg-emerald-100 text-emerald-700",
    yellow: "bg-amber-100 text-amber-700",
    red: "bg-red-100 text-red-700",
    blue: "bg-ark-blue-100 text-ark-blue-700",
    purple: "bg-purple-100 text-purple-700",
  };
  return <span className={clsx("rounded-full px-2 py-0.5 text-xs font-medium", colors[color])}>{children}</span>;
}
