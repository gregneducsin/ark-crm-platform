import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  SupportConversationSummary,
  SupportConversationDetail,
  SendSupportConversationReplyResponse,
} from "@luma/shared";
import { api } from "../lib/apiClient";

const LIST_POLL_INTERVAL_MS = 8_000;
const DETAIL_POLL_INTERVAL_MS = 4_000;

export type SupportConversationChannel = "sms" | "email";

export function useSupportConversationsList(channel: SupportConversationChannel) {
  return useQuery({
    queryKey: ["support-conversations", "list", channel],
    queryFn: () => api.get<{ conversations: SupportConversationSummary[] }>("/api/app/support-conversations", { channel }),
    refetchInterval: LIST_POLL_INTERVAL_MS,
  });
}

export function useSupportConversationDetail(id: string | null, channel: SupportConversationChannel) {
  return useQuery({
    queryKey: ["support-conversations", "detail", channel, id],
    queryFn: () => api.get<SupportConversationDetail>(`/api/app/support-conversations/${id}`, { channel }),
    enabled: id !== null,
    refetchInterval: DETAIL_POLL_INTERVAL_MS,
  });
}

export function useClearSupportNeedsAttention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, channel }: { conversationId: string; channel: SupportConversationChannel }) =>
      api.post<{ ok: true }>(`/api/app/support-conversations/${conversationId}/clear-attention?channel=${channel}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["support-conversations"] });
    },
  });
}

/** A staff-authored reply, sent through the real SMS or email provider (per channel) and logged into the conversation like any other outbound message. */
export function useSendStaffReply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, body, channel }: { conversationId: string; body: string; channel: SupportConversationChannel }) =>
      api.post<SendSupportConversationReplyResponse>(`/api/app/support-conversations/${conversationId}/reply?channel=${channel}`, { body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["support-conversations"] });
    },
  });
}
