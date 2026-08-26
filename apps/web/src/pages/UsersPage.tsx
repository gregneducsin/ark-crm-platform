import { useState, type FormEvent } from "react";
import type { AuthUser } from "@luma/shared";
import { useUsers, useInviteUser, useUpdateUser, useResendInvite, useAdminResetPassword } from "../hooks/useUsers";
import { Badge, Button, Card, ErrorText, Field, Input } from "../components/ui";
import { ApiError, useCurrentUser } from "../hooks/useAuth";

const ROLE_LABEL: Record<AuthUser["role"], string> = {
  admin: "Admin",
  manager: "Manager",
  customer_service: "Customer Service",
};

const STATUS_COLOR: Record<AuthUser["status"], "green" | "yellow" | "red" | "gray"> = {
  active: "green",
  invited: "yellow",
  locked: "red",
  disabled: "gray",
};

export function UsersPage() {
  const [showInvite, setShowInvite] = useState(false);
  const { data, isLoading } = useUsers();
  const { data: currentUser } = useCurrentUser();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Users</h1>
        <Button onClick={() => setShowInvite((s) => !s)}>{showInvite ? "Cancel" : "Invite user"}</Button>
      </div>

      {showInvite && <InviteUserForm onDone={() => setShowInvite(false)} />}

      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <p className="p-4 text-sm text-gray-500">Loading…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {data?.users.map((u) => (
                <UserRow key={u.id} user={u} isSelf={u.id === currentUser?.user?.id} />
              ))}
              {data?.users.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-gray-400">
                    No users yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function UserRow({ user, isSelf }: { user: AuthUser; isSelf: boolean }) {
  const updateUser = useUpdateUser();
  const resendInvite = useResendInvite();
  const resetPassword = useAdminResetPassword();
  const canToggleStatus = user.status === "active" || user.status === "disabled";
  const canResetPassword = user.status === "active" || user.status === "locked";

  return (
    <tr className="border-b border-gray-100 last:border-0">
      <td className="px-4 py-2 text-gray-800">
        {user.firstName} {user.lastName}
        {isSelf && <span className="ml-1 text-xs text-gray-400">(you)</span>}
      </td>
      <td className="px-4 py-2 text-gray-600">{user.email}</td>
      <td className="px-4 py-2">
        {isSelf ? (
          <span className="text-gray-600">{ROLE_LABEL[user.role]}</span>
        ) : (
          <select
            className="rounded-md border border-gray-300 px-2 py-1 text-xs"
            value={user.role}
            disabled={updateUser.isPending}
            onChange={(e) => updateUser.mutate({ id: user.id, input: { role: e.target.value as AuthUser["role"] } })}
          >
            <option value="customer_service">Customer Service</option>
            <option value="manager">Manager</option>
            <option value="admin">Admin</option>
          </select>
        )}
      </td>
      <td className="px-4 py-2">
        <Badge color={STATUS_COLOR[user.status]}>{user.status}</Badge>
      </td>
      <td className="px-4 py-2">
        {!isSelf && (
          <div className="flex flex-wrap items-center gap-2">
            {canToggleStatus && (
              <Button
                variant="secondary"
                disabled={updateUser.isPending}
                onClick={() =>
                  updateUser.mutate({ id: user.id, input: { status: user.status === "disabled" ? "active" : "disabled" } })
                }
              >
                {user.status === "disabled" ? "Reactivate" : "Disable"}
              </Button>
            )}
            {user.status === "invited" && (
              <Button variant="secondary" disabled={resendInvite.isPending} onClick={() => resendInvite.mutate(user.id)}>
                {resendInvite.isPending ? "Sending…" : resendInvite.isSuccess ? "Invite sent" : "Resend invite"}
              </Button>
            )}
            {canResetPassword && (
              <Button variant="secondary" disabled={resetPassword.isPending} onClick={() => resetPassword.mutate(user.id)}>
                {resetPassword.isPending ? "Sending…" : resetPassword.isSuccess ? "Reset link sent" : "Reset password"}
              </Button>
            )}
            {(resendInvite.isError || resetPassword.isError) && (
              <ErrorText>
                {(() => {
                  const err = resendInvite.error ?? resetPassword.error;
                  return err instanceof ApiError ? err.message : "Something went wrong.";
                })()}
              </ErrorText>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

function InviteUserForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState<{ firstName: string; lastName: string; email: string; role: AuthUser["role"] }>({
    firstName: "",
    lastName: "",
    email: "",
    role: "customer_service",
  });
  const inviteUser = useInviteUser();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    inviteUser.mutate(form, { onSuccess: onDone });
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="First name">
          <Input required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
        </Field>
        <Field label="Last name">
          <Input required value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
        </Field>
        <Field label="Email">
          <Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Role">
          <select
            className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as AuthUser["role"] })}
          >
            <option value="customer_service">Customer Service</option>
            <option value="manager">Manager</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <div className="col-span-2 flex items-center gap-2 sm:col-span-4">
          <Button type="submit" disabled={inviteUser.isPending}>
            {inviteUser.isPending ? "Sending invite…" : "Send invite"}
          </Button>
          <ErrorText>
            {inviteUser.isError ? (inviteUser.error instanceof ApiError ? inviteUser.error.message : "Something went wrong.") : null}
          </ErrorText>
        </div>
      </form>
    </Card>
  );
}
