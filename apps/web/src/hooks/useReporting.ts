import { useQuery } from "@tanstack/react-query";
import type { FunnelSummary, MessageReportingResponse } from "@luma/shared";
import { api } from "../lib/apiClient";

export function useFunnelSummary() {
  return useQuery({
    queryKey: ["reporting", "funnel"],
    queryFn: () => api.get<FunnelSummary>("/api/app/reporting/funnel"),
  });
}

export function useMessageReporting() {
  return useQuery({
    queryKey: ["reporting", "messages"],
    queryFn: () => api.get<MessageReportingResponse>("/api/app/reporting/messages"),
  });
}
