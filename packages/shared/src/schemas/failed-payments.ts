import { z } from "zod";

/**
 * "open" means still needs a human decision — reach out, note it, or accept
 * it's a lost order. "resolved" means staff decided this one's handled
 * (customer paid another way, we followed up and gave up, etc.) — separate
 * from purchases.status, which tracks the underlying order's own state.
 */
export const failedPaymentResolutionStatusSchema = z.enum(["open", "resolved"]);
export type FailedPaymentResolutionStatus = z.infer<typeof failedPaymentResolutionStatusSchema>;

export const failedPaymentItemSchema = z.object({
  id: z.string(),
  personId: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  externalPersonId: z.string(),
  transactionId: z.string(),
  amount: z.string().nullable(),
  failureDate: z.string(),
  paymentMethodType: z.string().nullable(),
  cardBrand: z.string().nullable(),
  cardLast4: z.string().nullable(),
  transactionResponse: z.string().nullable(),
  sourceStatus: z.string().nullable(),
  testMode: z.boolean(),
  resolutionStatus: failedPaymentResolutionStatusSchema,
  resolvedAt: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
});
export type FailedPaymentItem = z.infer<typeof failedPaymentItemSchema>;

export const failedPaymentsListResponseSchema = z.object({
  items: z.array(failedPaymentItemSchema),
});
export type FailedPaymentsListResponse = z.infer<typeof failedPaymentsListResponseSchema>;

export const resolveFailedPaymentRequestSchema = z.object({
  notes: z.string().trim().max(2000).optional(),
});
export type ResolveFailedPaymentRequest = z.infer<typeof resolveFailedPaymentRequestSchema>;
