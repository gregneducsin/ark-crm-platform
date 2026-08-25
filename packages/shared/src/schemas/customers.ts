import { z } from "zod";

export const customerSchema = z.object({
  id: z.string().uuid(),
  personNumber: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().email(),
  phone: z.string().nullable(),
  leadReceivedDate: z.string(),
  leadType: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Customer = z.infer<typeof customerSchema>;

export const customerQuestionnaireEventSchema = z.object({
  questionnaireId: z.string(),
  status: z.string(),
  startedAt: z.string().nullable(),
  abandonedAt: z.string().nullable(),
  lastEventAt: z.string(),
});
export type CustomerQuestionnaireEvent = z.infer<typeof customerQuestionnaireEventSchema>;

export const createCustomerRequestSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(1).optional(),
  leadReceivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
  leadType: z.string().min(1).optional(),
});
export type CreateCustomerRequest = z.infer<typeof createCustomerRequestSchema>;

export const updateCustomerRequestSchema = createCustomerRequestSchema.partial();
export type UpdateCustomerRequest = z.infer<typeof updateCustomerRequestSchema>;

export const listCustomersQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  sortBy: z.enum(["createdAt", "leadReceivedDate", "lastName"]).default("createdAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  leadType: z.string().trim().min(1).optional(),
  purchaseStatus: z.enum(["purchased", "not_purchased"]).optional(),
  // Filters to customers with a questionnaire_events row for this specific
  // questionnaire ID (e.g. Bask's numeric questionnaire ID) — not a status
  // bucket, since the same person can have events across several distinct
  // questionnaires.
  questionnaireId: z.string().trim().min(1).optional(),
  // Inclusive range filter on leadReceivedDate — the same business date the
  // dashboard summary tiles filter by, not the DB row's createdAt.
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").optional(),
});
export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;

// Aggregated stats computed at query time, not stored columns.
export const customerWithStatsSchema = customerSchema.extend({
  purchaseCount: z.number().int(),
  totalPaid: z.string(),
  firstPurchaseDate: z.string().nullable(),
  mostRecentPurchaseDate: z.string().nullable(),
  // Date of this customer's completed, first-order purchase, if any — the
  // same "did this lead convert" rule the summary tiles and Marketing CPA
  // use (a recurring-only purchase does not count). Drives the Purchased/Not
  // Purchased badge and filter, distinct from purchaseCount/totalPaid above,
  // which reflect the customer's full order history regardless of
  // classification.
  qualifyingPurchaseDate: z.string().nullable(),
  // Most recent questionnaire_events row for this customer, if any — status
  // and questionnaireId are the same row (paired by the same "most recent
  // by lastEventAt" subquery), so they're always in sync with each other.
  questionnaireStatus: z.string().nullable(),
  questionnaireId: z.string().nullable(),
});
export type CustomerWithStats = z.infer<typeof customerWithStatsSchema>;

export const customersSummaryQuerySchema = z.object({
  // Number of trailing days to include, or "all" for no date filter.
  period: z.union([z.coerce.number().int().positive(), z.literal("all")]).default(30),
});
export type CustomersSummaryQuery = z.infer<typeof customersSummaryQuerySchema>;

export const customersSummarySchema = z.object({
  totalLeads: z.number().int(),
  // Source is the system that created the customer first (their earliest
  // external_identities row) — every lead with a known source falls into
  // exactly one of these two buckets, no double-counting. Leads created
  // manually in the dashboard (no external identity at all) count toward
  // totalLeads but neither bucket.
  metaFormFillCount: z.number().int(),
  questionnaireCount: z.number().int(),
  purchased: z.number().int(),
  notPurchased: z.number().int(),
  conversionRate: z.number(),
});
export type CustomersSummary = z.infer<typeof customersSummarySchema>;

export const customerNoteSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid(),
  authorEmail: z.string().email(),
  body: z.string(),
  createdAt: z.string(),
});
export type CustomerNote = z.infer<typeof customerNoteSchema>;

export const createCustomerNoteRequestSchema = z.object({
  body: z.string().min(1).max(2000),
});
export type CreateCustomerNoteRequest = z.infer<typeof createCustomerNoteRequestSchema>;

export const customerNotesListResponseSchema = z.object({
  notes: z.array(customerNoteSchema),
});
export type CustomerNotesListResponse = z.infer<typeof customerNotesListResponseSchema>;
