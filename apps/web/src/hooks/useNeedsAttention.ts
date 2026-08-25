import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { NeedsAttentionListResponse, NeedsAttentionMessagesResponse, NeedsAttentionChannel, NeedsAttentionPersona } from "@luma/shared";
import { api } from "../lib/apiClient";

const LIST_POLL_INTERVAL_MS = 15_000;

/**
 * `enabled` should mirror the same admin/manager role gate the backend route
 * enforces (see requireRole in needs-attention.routes.ts) — an employee-role
 * user would otherwise get a 401 from this poll on every page in the app,
 * since Layout renders the nav badge count everywhere. Defaults to true for
 * pages (like NeedsAttentionPage itself) that are only reachable by roles
 * that already passed the same check to get there.
 */
export function useNeedsAttentionList(enabled = true) {
  return useQuery({
    queryKey: ["needs-attention", "list"],
    queryFn: () => api.get<NeedsAttentionListResponse>("/api/app/needs-attention"),
    refetchInterval: LIST_POLL_INTERVAL_MS,
    enabled,
  });
}

export function useNeedsAttentionMessages(channel: NeedsAttentionChannel, persona: NeedsAttentionPersona, conversationId: string | null) {
  return useQuery({
    queryKey: ["needs-attention", "messages", channel, persona, conversationId],
    queryFn: () => api.get<NeedsAttentionMessagesResponse>(`/api/app/needs-attention/${channel}/${persona}/${conversationId}/messages`),
    enabled: conversationId !== null,
  });
}

export function useClearNeedsAttentionItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channel, persona, conversationId }: { channel: NeedsAttentionChannel; persona: NeedsAttentionPersona; conversationId: string }) =>
      api.post<{ ok: true }>(`/api/app/needs-attention/${channel}/${persona}/${conversationId}/clear`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["needs-attention"] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.invalidateQueries({ queryKey: ["support-conversations"] });
    },
  });
}
