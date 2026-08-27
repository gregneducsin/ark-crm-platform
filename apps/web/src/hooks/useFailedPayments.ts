import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { FailedPaymentsListResponse, FailedPaymentResolutionStatus } from "@luma/shared";
import { api } from "../lib/apiClient";

export function useFailedPaymentsList(status: FailedPaymentResolutionStatus | "all" = "open") {
  return useQuery({
    queryKey: ["failed-payments", "list", status],
    queryFn: () => api.get<FailedPaymentsListResponse>(`/api/app/failed-payments?status=${status}`),
  });
}

export function useResolveFailedPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, notes }: { id: string; notes?: string }) => api.post<{ ok: true }>(`/api/app/failed-payments/${id}/resolve`, { notes }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["failed-payments"] }),
  });
}

export function useReopenFailedPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ ok: true }>(`/api/app/failed-payments/${id}/reopen`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["failed-payments"] }),
  });
}
