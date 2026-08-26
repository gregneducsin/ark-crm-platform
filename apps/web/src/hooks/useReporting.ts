import { useQuery } from "@tanstack/react-query";
import type { DateRangeQuery, FunnelSummary, MessageReportingResponse } from "@luma/shared";
import { api } from "../lib/apiClient";

export function useFunnelSummary(range?: DateRangeQuery, enabled = true) {
  return useQuery({
    queryKey: ["reporting", "funnel", range?.from, range?.to],
    queryFn: () => api.get<FunnelSummary>("/api/app/reporting/funnel", range as Record<string, string | undefined>),
    enabled,
  });
}

export function useMessageReporting() {
  return useQuery({
    queryKey: ["reporting", "messages"],
    queryFn: () => api.get<MessageReportingResponse>("/api/app/reporting/messages"),
  });
}
