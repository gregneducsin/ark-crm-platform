import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthUser, InviteUserRequest, UpdateUserRequest } from "@luma/shared";
import { api } from "../lib/apiClient";

export function useUsers() {
  return useQuery({
    queryKey: ["users", "list"],
    queryFn: () => api.get<{ users: AuthUser[] }>("/api/app/users"),
  });
}

export function useInviteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: InviteUserRequest) => api.post<{ user: AuthUser }>("/api/app/users", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users", "list"] }),
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateUserRequest }) => api.patch<{ user: AuthUser }>(`/api/app/users/${id}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users", "list"] }),
  });
}
