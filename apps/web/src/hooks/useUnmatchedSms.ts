import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { UnmatchedSmsListResponse, UnmatchedSmsThreadDetail, SendUnmatchedSmsReplyResponse } from "@luma/shared";
import { api } from "../lib/apiClient";

const LIST_POLL_INTERVAL_MS = 15_000;

/** Same enabled-gate reasoning as useNeedsAttentionList — this powers a nav badge visible on every page. */
export function useUnmatchedSmsList(enabled = true) {
  return useQuery({
    queryKey: ["unmatched-sms", "list"],
    queryFn: () => api.get<UnmatchedSmsListResponse>("/api/app/unmatched-sms"),
    refetchInterval: LIST_POLL_INTERVAL_MS,
    enabled,
  });
}

export function useUnmatchedSmsThread(id: string | null) {
  return useQuery({
    queryKey: ["unmatched-sms", "detail", id],
    queryFn: () => api.get<UnmatchedSmsThreadDetail>(`/api/app/unmatched-sms/${id}`),
    enabled: id !== null,
  });
}

/** The only send path in this feature — a staff member approves and sends the (possibly edited) suggested reply. */
export function useSendUnmatchedSmsReply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => api.post<SendUnmatchedSmsReplyResponse>(`/api/app/unmatched-sms/${id}/reply`, { body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["unmatched-sms"] });
    },
  });
}

export function useDismissUnmatchedSms() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ ok: true }>(`/api/app/unmatched-sms/${id}/dismiss`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["unmatched-sms"] });
    },
  });
}
