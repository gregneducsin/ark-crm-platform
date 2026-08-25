import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { UnmatchedEmailsListResponse, UnmatchedEmailThreadDetail, SendUnmatchedEmailReplyResponse } from "@luma/shared";
import { api } from "../lib/apiClient";

const LIST_POLL_INTERVAL_MS = 15_000;

/** Same enabled-gate reasoning as useNeedsAttentionList — this powers a nav badge visible on every page. */
export function useUnmatchedEmailsList(enabled = true) {
  return useQuery({
    queryKey: ["unmatched-emails", "list"],
    queryFn: () => api.get<UnmatchedEmailsListResponse>("/api/app/unmatched-emails"),
    refetchInterval: LIST_POLL_INTERVAL_MS,
    enabled,
  });
}

export function useUnmatchedEmailThread(id: string | null) {
  return useQuery({
    queryKey: ["unmatched-emails", "detail", id],
    queryFn: () => api.get<UnmatchedEmailThreadDetail>(`/api/app/unmatched-emails/${id}`),
    enabled: id !== null,
  });
}

/** The only send path in this feature — a staff member approves and sends the (possibly edited) suggested reply. */
export function useSendUnmatchedEmailReply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => api.post<SendUnmatchedEmailReplyResponse>(`/api/app/unmatched-emails/${id}/reply`, { body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["unmatched-emails"] });
    },
  });
}

export function useDismissUnmatchedEmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ ok: true }>(`/api/app/unmatched-emails/${id}/dismiss`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["unmatched-emails"] });
    },
  });
}
