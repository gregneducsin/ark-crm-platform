import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConversationPersona, UnifiedConversationChannel, UnifiedConversationDetail, UnifiedConversationSummary, SalesResponseStats, SendUnifiedConversationReplyResponse } from "@luma/shared";
import { api } from "../lib/apiClient";

const LIST_POLL_INTERVAL_MS = 8_000;
const DETAIL_POLL_INTERVAL_MS = 4_000;

export function useUnifiedConversationsList() {
  return useQuery({
    queryKey: ["conversations", "list"],
    queryFn: () => api.get<{ conversations: UnifiedConversationSummary[]; salesStats: SalesResponseStats }>("/api/app/conversations"),
    refetchInterval: LIST_POLL_INTERVAL_MS,
  });
}

export function useUnifiedConversationDetail(personId: string | null) {
  return useQuery({
    queryKey: ["conversations", "detail", personId],
    queryFn: () => api.get<UnifiedConversationDetail>(`/api/app/conversations/${personId}`),
    enabled: personId !== null,
    refetchInterval: DETAIL_POLL_INTERVAL_MS,
  });
}

/** Clears every currently-flagged thread (sales + support, sms + email) for this person in one action. */
export function useClearAllNeedsAttention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (personId: string) => api.post<{ ok: true }>(`/api/app/conversations/${personId}/clear-attention`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["conversations"] }),
  });
}

/** A staff-authored reply, sent through whichever of the four pipelines (persona x channel) is chosen. */
export function useSendUnifiedStaffReply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ personId, persona, channel, body }: { personId: string; persona: ConversationPersona; channel: UnifiedConversationChannel; body: string }) =>
      api.post<SendUnifiedConversationReplyResponse>(`/api/app/conversations/${personId}/reply`, { persona, channel, body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["conversations"] }),
  });
}
