import { useQuery, useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { ConversationPersona, UnifiedConversationChannel, UnifiedConversationDetail, UnifiedConversationPage, UnifiedConversationPageResponse, UnifiedConversationListOptions, UnifiedConversationStats, SendUnifiedConversationReplyResponse } from "@luma/shared";
import { api } from "../lib/apiClient";

const LIST_POLL_INTERVAL_MS = 8_000;
const DETAIL_POLL_INTERVAL_MS = 4_000;

type CachedPage = UnifiedConversationPage & { cursor: string | null };

export function useUnifiedConversationStats() {
  return useQuery({
    queryKey: ["conversations", "stats"],
    queryFn: () => api.get<UnifiedConversationStats>("/api/app/conversations/stats"),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

export function useUnifiedConversationsList(options: Pick<UnifiedConversationListOptions, "search" | "leadSource" | "onlyNeedsAttention"> = {}) {
  const queryClient = useQueryClient();
  const queryKey = ["conversations", "list", options] as const;
  return useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<CachedPage> => {
      const cached = queryClient.getQueryData<InfiniteData<CachedPage>>(queryKey)?.pages.find(page => page.cursor === pageParam);
      const response = await api.get<UnifiedConversationPageResponse>("/api/app/conversations/pages", {
        search: options.search,
        leadSource: options.leadSource,
        onlyNeedsAttention: options.onlyNeedsAttention ? "1" : "0",
        limit: 50,
        cursor: pageParam ?? undefined,
        version: cached?.version,
      });
      if ("unchanged" in response) {
        if (!cached) throw new Error("Inbox refresh requires a cached page.");
        return cached;
      }
      return { ...response, cursor: pageParam };
    },
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
    // Infinite-query refreshes loaded pages in order using fresh cursors,
    // so activity moving a row to the top does not leave permanent gaps.
    refetchInterval: LIST_POLL_INTERVAL_MS,
    staleTime: LIST_POLL_INTERVAL_MS,
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
