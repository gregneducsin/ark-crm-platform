import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthUser } from "@luma/shared";
import { api, ApiError } from "../lib/apiClient";

const ME_QUERY_KEY = ["auth", "me"] as const;

export function useCurrentUser() {
  return useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: () => api.get<{ user: AuthUser | null }>("/api/app/auth/me"),
    staleTime: 60_000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) => api.post<{ user: AuthUser }>("/api/app/auth/login", input),
    onSuccess: (data) => {
      queryClient.setQueryData(ME_QUERY_KEY, { user: data.user });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/api/app/auth/logout"),
    onSuccess: () => {
      queryClient.setQueryData(ME_QUERY_KEY, { user: null });
      queryClient.clear();
    },
  });
}

export function useAcceptInvitation() {
  return useMutation({
    mutationFn: (input: { token: string; password: string }) => api.post<{ ok: boolean }>("/api/app/auth/accept-invitation", input),
  });
}

export { ApiError };
