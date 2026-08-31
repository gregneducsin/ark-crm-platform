import { useQuery } from "@tanstack/react-query";
import type { WebhookEventsListResponse, WebhookEventStatus } from "@luma/shared";
import { api } from "../lib/apiClient";

export function useWebhookEventsList(status: WebhookEventStatus | "all" = "all", source?: string) {
  const params = new URLSearchParams({ status });
  if (source) params.set("source", source);
  return useQuery({
    queryKey: ["webhook-events", "list", status, source ?? "all"],
    queryFn: () => api.get<WebhookEventsListResponse>(`/api/app/webhook-events?${params.toString()}`),
    refetchInterval: 15000,
  });
}
