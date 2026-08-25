import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  ConversationSummary,
  ConversationDetail,
  ConversationResponseStats,
  SendConversationReplyResponse,
} from "@luma/shared";
import { api } from "../lib/apiClient";

const LIST_POLL_INTERVAL_MS = 8_000;
const DETAIL_POLL_INTERVAL_MS = 4_000;

export type ConversationChannel = "sms" | "email";

export function useConversationsList(channel: ConversationChannel) {
  return useQuery({
    queryKey: ["conversations", "list", channel],
    queryFn: () =>
      api.get<{ conversations: ConversationSummary[]; stats: ConversationResponseStats }>("/api/app/conversations", { channel }),
    refetchInterval: LIST_POLL_INTERVAL_MS,
  });
}

export function useConversationDetail(id: string | null, channel: ConversationChannel) {
  return useQuery({
    queryKey: ["conversations", "detail", channel, id],
    queryFn: () => api.get<ConversationDetail>(`/api/app/conversations/${id}`, { channel }),
    enabled: id !== null,
    refetchInterval: DETAIL_POLL_INTERVAL_MS,
  });
}

export function useClearNeedsAttention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, channel }: { conversationId: string; channel: ConversationChannel }) =>
      api.post<{ ok: true }>(`/api/app/conversations/${conversationId}/clear-attention?channel=${channel}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

/** A staff-authored reply, sent through the real SMS or email provider (per channel) and logged into the conversation like any other outbound message. */
export function useSendStaffReply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, body, channel }: { conversationId: string; body: string; channel: ConversationChannel }) =>
      api.post<SendConversationReplyResponse>(`/api/app/conversations/${conversationId}/reply?channel=${channel}`, { body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
