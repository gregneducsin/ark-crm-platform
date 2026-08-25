import { z } from "zod";

export const purchaseStatusSchema = z.enum(["pending", "completed", "refunded", "cancelled", "payment_failed"]);
export const purchaseClassificationSchema = z.enum(["first_order", "recurring", "unknown"]);
export const purchaseClassificationSourceSchema = z.enum(["bask", "purchase_history", "manual", "unknown"]);

export const purchaseSchema = z.object({
  id: z.number().int(),
  customerId: z.string().uuid(),
  purchaseDate: z.string(),
  orderNumber: z.string(),
  productName: z.string(),
  amountPaid: z.string(),
  status: purchaseStatusSchema,
  ecommerceOrderId: z.string().nullable(),
  orderClassification: purchaseClassificationSchema.nullable(),
  orderClassificationSource: purchaseClassificationSourceSchema.nullable(),
  createdAt: z.string(),
});
export type Purchase = z.infer<typeof purchaseSchema>;

export const createPurchaseRequestSchema = z.object({
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
  orderNumber: z.string().min(1),
  productName: z.string().min(1),
  amountPaid: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a decimal amount, e.g. 49.99"),
  status: purchaseStatusSchema.optional(),
  ecommerceOrderId: z.string().min(1).optional(),
});
export type CreatePurchaseRequest = z.infer<typeof createPurchaseRequestSchema>;

export const updatePurchaseRequestSchema = z.object({
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  orderNumber: z.string().min(1).optional(),
  productName: z.string().min(1).optional(),
  amountPaid: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  status: purchaseStatusSchema.optional(),
  orderClassification: purchaseClassificationSchema.optional(),
});
export type UpdatePurchaseRequest = z.infer<typeof updatePurchaseRequestSchema>;

export const listPurchasesQuerySchema = z.object({
  sortBy: z.enum(["purchaseDate", "amountPaid"]).default("purchaseDate"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  orderClassification: purchaseClassificationSchema.optional(),
  status: purchaseStatusSchema.optional(),
});
export type ListPurchasesQuery = z.infer<typeof listPurchasesQuerySchema>;

export const purchaseWithCustomerSchema = purchaseSchema.extend({
  customerFirstName: z.string(),
  customerLastName: z.string(),
  customerPersonNumber: z.string(),
});
export type PurchaseWithCustomer = z.infer<typeof purchaseWithCustomerSchema>;

export const purchasesSummaryQuerySchema = z.object({
  // Number of trailing days to include (by purchaseDate), or "all" for no date filter.
  period: z.union([z.coerce.number().int().positive(), z.literal("all")]).default(30),
});
export type PurchasesSummaryQuery = z.infer<typeof purchasesSummaryQuerySchema>;

export const purchasesSummarySchema = z.object({
  purchasingCustomers: z.number().int(),
  totalRevenue: z.string(),
  totalCompletedOrders: z.number().int(),
  newCustomers: z.number().int(),
  recurringCustomers: z.number().int(),
});
export type PurchasesSummary = z.infer<typeof purchasesSummarySchema>;
