import { type ReactNode, useEffect } from "react";
import { useLocation } from "wouter";
import type { AuthUser } from "@luma/shared";
import { useCurrentUser } from "../hooks/useAuth";
import { Layout } from "./Layout";

/**
 * roles: which of the 3 fixed roles may view this page. Omit to allow any
 * authenticated user (the login-only gate this component always did). The
 * backend enforces the real permission boundary on every request regardless
 * — this only spares a role from landing on a page that would just come
 * back empty/403 for them.
 */
export function ProtectedRoute({ children, roles }: { children: ReactNode; roles?: readonly AuthUser["role"][] }) {
  const { data, isLoading } = useCurrentUser();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!isLoading && !data?.user) {
      navigate("/login");
    }
  }, [isLoading, data?.user, navigate]);

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-gray-500">Loading…</div>;
  }
  if (!data?.user) {
    return null;
  }
  if (roles && !roles.includes(data.user.role)) {
    return (
      <Layout>
        <div className="flex min-h-[50vh] items-center justify-center text-sm text-gray-500">You don't have access to this page.</div>
      </Layout>
    );
  }
  return <Layout>{children}</Layout>;
}
