import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Employee,
  CreateEmployeeRequest,
  UpdateEmployeeRequest,
  PayrollWeek,
  CreatePayrollWeekRequest,
  UpsertWeeklyHoursRequest,
  CreateBonusRequest,
  MarketingCpaWeek,
  CreateMarketingSpendWeekRequest,
  UpdateMarketingSpendWeekRequest,
} from "@luma/shared";
import { api } from "../lib/apiClient";

// ── Employees ────────────────────────────────────────────────────────────────

export function useEmployees() {
  return useQuery({
    queryKey: ["employees", "list"],
    queryFn: () => api.get<{ employees: Employee[] }>("/api/app/payroll/employees"),
  });
}

export function useCreateEmployee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateEmployeeRequest) => api.post<{ employee: Employee }>("/api/app/payroll/employees", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["employees", "list"] }),
  });
}

export function useUpdateEmployee(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateEmployeeRequest) => api.patch<{ employee: Employee }>(`/api/app/payroll/employees/${id}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["employees", "list"] }),
  });
}

// ── Payroll weeks ────────────────────────────────────────────────────────────

export function usePayrollWeeks() {
  return useQuery({
    queryKey: ["payrollWeeks", "list"],
    queryFn: () => api.get<{ weeks: PayrollWeek[] }>("/api/app/payroll/weeks"),
  });
}

interface WeeklyHoursEntry {
  id: string;
  employeeId: string;
  employeeFirstName: string;
  employeeLastName: string;
  hoursWorked: string;
  hourlyRateSnapshot: string;
  hourlyEarnings: string;
  totalDeals: number | null;
  commissionAmount: string | null;
}

interface Bonus {
  id: string;
  employeeId: string;
  amount: string;
  description: string;
}

export function usePayrollWeekDetail(id: string | undefined) {
  return useQuery({
    queryKey: ["payrollWeeks", "detail", id],
    queryFn: () => api.get<{ week: PayrollWeek; hours: WeeklyHoursEntry[]; bonuses: Bonus[] }>(`/api/app/payroll/weeks/${id}`),
    enabled: !!id,
  });
}

export function useCreatePayrollWeek() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePayrollWeekRequest) => api.post<{ week: PayrollWeek }>("/api/app/payroll/weeks", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["payrollWeeks", "list"] }),
  });
}

function useWeekTransition(weekId: string, action: "approve" | "pay") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ week: PayrollWeek }>(`/api/app/payroll/weeks/${weekId}/${action}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payrollWeeks", "list"] });
      queryClient.invalidateQueries({ queryKey: ["payrollWeeks", "detail", weekId] });
    },
  });
}

export const useApprovePayrollWeek = (weekId: string) => useWeekTransition(weekId, "approve");
export const usePayPayrollWeek = (weekId: string) => useWeekTransition(weekId, "pay");

export function useUpsertWeeklyHours(weekId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertWeeklyHoursRequest) => api.put<{ entry: WeeklyHoursEntry }>(`/api/app/payroll/weeks/${weekId}/hours`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["payrollWeeks", "detail", weekId] }),
  });
}

export function useCreateBonus(weekId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBonusRequest) => api.post<{ bonus: Bonus }>(`/api/app/payroll/weeks/${weekId}/bonuses`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["payrollWeeks", "detail", weekId] }),
  });
}

// ── Marketing CPA ────────────────────────────────────────────────────────────

export function useMarketingCpaWeeks() {
  return useQuery({
    queryKey: ["marketingCpaWeeks", "list"],
    queryFn: () => api.get<{ weeks: MarketingCpaWeek[] }>("/api/app/payroll/marketing-spend"),
  });
}

export function useCreateMarketingSpendWeek() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMarketingSpendWeekRequest) =>
      api.post<{ week: MarketingCpaWeek }>("/api/app/payroll/marketing-spend", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["marketingCpaWeeks", "list"] }),
  });
}

export function useUpdateMarketingSpendWeek(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMarketingSpendWeekRequest) =>
      api.patch<{ week: MarketingCpaWeek }>(`/api/app/payroll/marketing-spend/${id}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["marketingCpaWeeks", "list"] }),
  });
}
