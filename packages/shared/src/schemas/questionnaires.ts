import { z } from "zod";

export const questionnairesQuerySchema = z
  .object({
    // Number of trailing days to include (by questionnaire event activity),
    // or "all" for no date filter. Ignored when dateFrom/dateTo are given —
    // see purchasesSummaryQuerySchema's comment for why an explicit range
    // is kept separate from period.
    period: z.union([z.coerce.number().int().positive(), z.literal("all")]).optional(),
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").optional(),
    dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").optional(),
  })
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, { message: "dateFrom must be on or before dateTo" });
export type QuestionnairesQuery = z.infer<typeof questionnairesQuerySchema>;

export const questionnairesSummarySchema = z.object({
  leadsWithQuestionnaire: z.number().int(),
  firstTimeCustomers: z.number().int(),
  completedPurchases: z.number().int(),
  totalRevenue: z.string(),
  conversionRate: z.number(),
});
export type QuestionnairesSummary = z.infer<typeof questionnairesSummarySchema>;

export const questionnaireBreakdownRowSchema = z.object({
  questionnaireId: z.string(),
  leads: z.number().int(),
  customers: z.number().int(),
  conversionRate: z.number(),
  purchases: z.number().int(),
  revenue: z.string(),
  avgValue: z.string().nullable(),
  lastPurchase: z.string().nullable(),
});
export type QuestionnaireBreakdownRow = z.infer<typeof questionnaireBreakdownRowSchema>;

export const questionnairesResponseSchema = z.object({
  summary: questionnairesSummarySchema,
  rows: z.array(questionnaireBreakdownRowSchema),
});
export type QuestionnairesResponse = z.infer<typeof questionnairesResponseSchema>;
