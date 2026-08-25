import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Customer,
  CustomerWithStats,
  CreateCustomerRequest,
  UpdateCustomerRequest,
  ListCustomersQuery,
  CustomersSummary,
  CustomersSummaryQuery,
  Purchase,
  PurchaseWithCustomer,
  ListPurchasesQuery,
  PurchasesSummary,
  PurchasesSummaryQuery,
  CreatePurchaseRequest,
  UpdatePurchaseRequest,
  QuestionnairesQuery,
  QuestionnairesResponse,
  IntakeLinkResponse,
  CustomerQuestionnaireEvent,
  CustomerNote,
  CreateCustomerNoteRequest,
} from "@luma/shared";
import { api } from "../lib/apiClient";

export function useCustomersList(query: Partial<ListCustomersQuery>) {
  return useQuery({
    queryKey: ["customers", "list", query],
    queryFn: () =>
      api.get<{ customers: CustomerWithStats[]; total: number }>(
        "/api/app/customers",
        query as Record<string, string | number | undefined>,
      ),
  });
}

export function useCustomersSummary(query: Partial<CustomersSummaryQuery>) {
  return useQuery({
    queryKey: ["customers", "summary", query],
    queryFn: () => api.get<CustomersSummary>("/api/app/customers/summary", query as Record<string, string | number | undefined>),
  });
}

export function useLeadTypes() {
  return useQuery({
    queryKey: ["customers", "lead-types"],
    queryFn: () => api.get<{ leadTypes: string[] }>("/api/app/customers/lead-types"),
  });
}

export function useQuestionnaireIds() {
  return useQuery({
    queryKey: ["customers", "questionnaire-ids"],
    queryFn: () => api.get<{ questionnaireIds: string[] }>("/api/app/customers/questionnaire-ids"),
  });
}

export function useQuestionnairesData(query: Partial<QuestionnairesQuery>) {
  return useQuery({
    queryKey: ["questionnaires", "data", query],
    queryFn: () => api.get<QuestionnairesResponse>("/api/app/questionnaires", query as Record<string, string | number | undefined>),
  });
}

export function usePurchasesList(query: Partial<ListPurchasesQuery>) {
  return useQuery({
    queryKey: ["purchases", "list", query],
    queryFn: () =>
      api.get<{ purchases: PurchaseWithCustomer[]; total: number }>(
        "/api/app/purchases",
        query as Record<string, string | number | undefined>,
      ),
  });
}

export function usePurchasesSummary(query: Partial<PurchasesSummaryQuery>) {
  return useQuery({
    queryKey: ["purchases", "summary", query],
    queryFn: () => api.get<PurchasesSummary>("/api/app/purchases/summary", query as Record<string, string | number | undefined>),
  });
}

export function useCustomer(id: string | undefined) {
  return useQuery({
    queryKey: ["customers", "detail", id],
    queryFn: () =>
      api.get<{ customer: Customer; purchases: Purchase[]; questionnaireEvents: CustomerQuestionnaireEvent[] }>(`/api/app/customers/${id}`),
    enabled: !!id,
  });
}

export function useCreateCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCustomerRequest) => api.post<{ customer: Customer }>("/api/app/customers", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers", "list"] });
      // A new lead changes the dashboard's lead-count tiles — without this,
      // the summary bar stays stale until a full page reload.
      queryClient.invalidateQueries({ queryKey: ["customers", "summary"] });
    },
  });
}

export function useUpdateCustomer(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateCustomerRequest) => api.patch<{ customer: Customer }>(`/api/app/customers/${id}`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers", "list"] });
      queryClient.invalidateQueries({ queryKey: ["customers", "detail", id] });
    },
  });
}

export function useCreatePurchase(customerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePurchaseRequest) => api.post<{ purchase: Purchase }>(`/api/app/customers/${customerId}/purchases`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers", "detail", customerId] });
      queryClient.invalidateQueries({ queryKey: ["customers", "list"] });
      // A new purchase changes purchaser/revenue counts on the customers
      // summary bar, and the order itself needs to show up on the Orders tab.
      queryClient.invalidateQueries({ queryKey: ["customers", "summary"] });
      queryClient.invalidateQueries({ queryKey: ["purchases", "list"] });
      queryClient.invalidateQueries({ queryKey: ["purchases", "summary"] });
    },
  });
}

export function useCustomerNotes(customerId: string) {
  return useQuery({
    queryKey: ["customers", "notes", customerId],
    queryFn: () => api.get<{ notes: CustomerNote[] }>(`/api/app/customers/${customerId}/notes`),
  });
}

export function useCreateCustomerNote(customerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCustomerNoteRequest) => api.post<{ note: CustomerNote }>(`/api/app/customers/${customerId}/notes`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["customers", "notes", customerId] }),
  });
}

export function useCreateIntakeLink(customerId: string) {
  return useMutation({
    mutationFn: () => api.post<IntakeLinkResponse>(`/api/app/customers/${customerId}/intake-link`, {}),
  });
}

export function useUpdatePurchase(customerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: UpdatePurchaseRequest }) =>
      api.patch<{ purchase: Purchase }>(`/api/app/purchases/${id}`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers", "detail", customerId] });
      // Editing a purchase (amount, status, or first_order/recurring
      // classification) changes what the customers list row shows
      // (purchaseCount/totalPaid), the customers/purchases summary tiles,
      // and the Orders tab list — none of these were being refreshed before.
      queryClient.invalidateQueries({ queryKey: ["customers", "list"] });
      queryClient.invalidateQueries({ queryKey: ["customers", "summary"] });
      queryClient.invalidateQueries({ queryKey: ["purchases", "list"] });
      queryClient.invalidateQueries({ queryKey: ["purchases", "summary"] });
    },
  });
}
