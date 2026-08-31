import { z } from "zod";

// ── GoHighLevel lead webhook ──────────────────────────────────────────────────

export const ghlLeadWebhookRequestSchema = z.object({
  eventId: z.string().min(1),
  contactId: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(1).optional(),
  leadType: z.string().min(1).optional(),
  // Optional because some GHL workflow templates don't forward a timestamp
  // merge field — the handler defaults this to the time the webhook was
  // received, same pattern as the Bask questionnaire webhook.
  occurredAt: z.string().datetime().optional(),
});
export type GhlLeadWebhookRequest = z.infer<typeof ghlLeadWebhookRequestSchema>;

// ── Bask order webhook ────────────────────────────────────────────────────────

export const baskOrderWebhookRequestSchema = z
  .object({
    eventId: z.string().min(1),
    externalPersonId: z.string().min(1),
    email: z.string().email(),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    phone: z.string().min(1).optional(),
    // Bask's own field name — matches its native payload, not our internal
    // purchases.orderNumber column name. The handler maps orderId -> orderNumber.
    orderId: z.string().min(1),
    productName: z.string().min(1),
    // Bask sends this as a JSON number; other sources may send a formatted
    // string. The handler normalizes either to a fixed 2-decimal string.
    amountPaid: z.union([z.string().regex(/^\d+(\.\d{1,2})?$/), z.number().nonnegative()]),
    // A single full timestamp — the handler derives both the purchase date
    // (date-only) and the webhook-event occurred date from this one field,
    // since Bask only provides one timestamp, not two.
    purchasedAt: z.string().datetime(),
    ecommerceOrderId: z.string().min(1).optional(),
    // Bask's own transaction identifier — used as ecommerceOrderId when that
    // field isn't separately provided.
    transactionId: z.string().min(1).optional(),
    // Bask's own record of whether this is the customer's first order,
    // relayed verbatim (same field name) through the Zapier zap that maps
    // Bask's native "newOrder" webhook into this flat payload. Optional
    // because our own "does a prior purchase row exist" DB check is the
    // fallback when it's absent (older/misconfigured zaps). Accepts a
    // string too — confirmed against a real Zapier payload that this can
    // arrive as a capitalized Python-style "False"/"True" string rather
    // than a JSON boolean — left un-transformed (no .transform()) so this
    // stays a plain union type; a transform here breaks z.infer's
    // output-type computation for the surrounding .passthrough() object.
    // parseIsFirstOrder() in webhooks.service.ts does the string -> boolean
    // coercion instead.
    isFirstTimeOrder: z.union([z.boolean(), z.string()]).optional(),
  })
  // Bask's payload may include other fields we haven't modeled yet.
  // .passthrough() (instead of the default strip-unknown-keys behavior)
  // keeps them alive in
  // parsed.data, so the raw payload stored in webhook_events.raw_payload by
  // recordWebhookEventIfNew captures it on the next real delivery instead of
  // silently discarding it before we ever get to look.
  .passthrough();
export type BaskOrderWebhookRequest = z.infer<typeof baskOrderWebhookRequestSchema>;

// ── Bask questionnaire webhook ─────────────────────────────────────────────────

export const baskQuestionnaireWebhookRequestSchema = z.object({
  eventId: z.string().min(1),
  externalPersonId: z.string().min(1),
  email: z.string().email(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  questionnaireId: z.string().min(1),
  status: z.enum(["started", "abandoned", "submitted"]),
  // Optional because some source integrations (e.g. a Zapier relay in front
  // of Bask) don't forward a timestamp at all — the handler defaults this to
  // the time the webhook was received rather than requiring the caller to
  // manufacture one.
  occurredAt: z.string().datetime().optional(),
});
export type BaskQuestionnaireWebhookRequest = z.infer<typeof baskQuestionnaireWebhookRequestSchema>;

// ── Bask payment-failed webhook ────────────────────────────────────────────────

export const baskPaymentFailedWebhookRequestSchema = z.object({
  eventId: z.string().min(1),
  transactionId: z.string().min(1),
  externalPersonId: z.string().min(1),
  email: z.string().email().optional(),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  failureDate: z.string().datetime(),
  paymentMethodType: z.string().optional(),
  cardBrand: z.string().optional(),
  cardLast4: z.string().length(4).optional(),
  transactionResponse: z.string().optional(),
  sourceStatus: z.string().optional(),
  testMode: z.boolean().optional(),
});
export type BaskPaymentFailedWebhookRequest = z.infer<typeof baskPaymentFailedWebhookRequestSchema>;

// ── Bask payment-succeeded webhook ──────────────────────────────────────────────
//
// Confirms a previously-failed (or first-attempt) payment on an existing
// order has now gone through — e.g. a retry after the customer updated
// their card. Same field shape as bask-payment-failed minus the
// failure-specific fields, correlated the same way (transactionId against
// purchases.ecommerceOrderId).

export const baskPaymentSucceededWebhookRequestSchema = z.object({
  eventId: z.string().min(1),
  transactionId: z.string().min(1),
  externalPersonId: z.string().min(1),
  email: z.string().email().optional(),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  succeededAt: z.string().datetime().optional(),
});
export type BaskPaymentSucceededWebhookRequest = z.infer<typeof baskPaymentSucceededWebhookRequestSchema>;

// ── Bask payment-refunded webhook ───────────────────────────────────────────────
//
// Bask's own event is `{ type: "paymentRefunded", data: { patientId,
// transactionId, amount, status, transactionResponse, date, paymentMethod,
// testMode, sessionId, treatmentId } }` (owner-supplied, confirmed real) —
// no eventId of its own, so the Zap must synthesize one for idempotency
// (same requirement as every other Bask webhook here), and no email field,
// so customer matching is by externalPersonId only, no email fallback.
// Field names below are the flat, camelCase Zap-mapped shape this app's
// other Bask webhooks all use, not Bask's raw nested envelope directly —
// map `data.patientId` -> `externalPersonId`, `data.date` -> `refundDate`,
// `data.paymentMethod` -> `paymentMethodType`, matching the "Data X" ->
// camelCase convention already used for bask-prescription-written.
//
// `amount`'s cents-vs-dollars format is unconfirmed for this specific event
// (bask-payment-failed's `amount` arrives as bare cents, bask-payment-
// succeeded's arrives as dollars — the two other Bask payment webhooks
// disagree with each other) — apply the same conservative
// cents-if-no-decimal-point conversion bask-payment-failed uses until a
// real delivery confirms which format this one actually sends.
export const baskPaymentRefundedWebhookRequestSchema = z.object({
  eventId: z.string().min(1),
  transactionId: z.string().min(1),
  externalPersonId: z.string().min(1), // Bask's "data.patientId"
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  status: z.string().optional(),
  transactionResponse: z.string().optional(),
  refundDate: z.string().datetime().optional(), // Bask's "data.date"
  paymentMethodType: z.string().optional(), // Bask's "data.paymentMethod"
  testMode: z.boolean().optional(),
  sessionId: z.string().optional(),
  treatmentId: z.string().optional(),
});
export type BaskPaymentRefundedWebhookRequest = z.infer<typeof baskPaymentRefundedWebhookRequestSchema>;

// ── Bask prescription-written webhook ──────────────────────────────────────────
//
// SPECULATIVE — designed from Bask's raw trigger field labels (Data Patient
// Id, Data Prescription Id, ...), not yet verified against a real Zap "Data
// in" test payload the way ghl-lead and bask-order were. Field names here
// follow the same flat-camelCase convention the other Zaps were corrected
// to use; confirm against the real Zap POST body once it's built and adjust
// if Bask's actual field names differ, same lesson as bask-order's orderId.

export const baskPrescriptionWrittenWebhookRequestSchema = z.object({
  eventId: z.string().min(1),
  externalPersonId: z.string().min(1), // Bask's "Data Patient Id"
  email: z.string().email(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  prescriptionId: z.string().min(1).optional(),
  occurredAt: z.string().datetime().optional(),
});
export type BaskPrescriptionWrittenWebhookRequest = z.infer<typeof baskPrescriptionWrittenWebhookRequestSchema>;

// ── Bask order-shipped webhook ─────────────────────────────────────────────────
//
// Confirmed against a real delivery: this event carries only
// externalPersonId, trackingNumber, and occurredAt — no eventId, no email,
// none of the richer newOrder-event fields. eventId and email are optional
// here (unlike every other Bask webhook) specifically because of that; see
// handleBaskOrderShippedWebhook for how it copes with both being absent.
// Bask's real payload also carries nested products/shipments arrays (drug
// name, dosage strength, pharmacy, etc.) — deliberately not modeled here
// since Sophie's shipped notice only needs the tracking number, not
// per-item clinical detail.

export const baskOrderShippedWebhookRequestSchema = z.object({
  eventId: z.string().min(1).optional(),
  externalPersonId: z.string().min(1), // Bask's "Data Patient Id"
  email: z.string().email().optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  orderId: z.string().min(1).optional(),
  orderNumber: z.string().min(1).optional(),
  trackingNumber: z.string().min(1),
  occurredAt: z.string().datetime().optional(),
});
export type BaskOrderShippedWebhookRequest = z.infer<typeof baskOrderShippedWebhookRequestSchema>;

// ── iBluSend inbound webhook (outbound from iBluSend's own perspective) ────────
//
// The envelope is shared across every event type iBluSend can deliver
// (message.received, message.sent, message.failed, message.delivered,
// message.read, reaction.received, contact.created, contact.opted_out,
// contact.resubscribed, device.status_changed, device.health_changed) — we
// only act on a subset, so `data` is validated loosely here (passthrough)
// and narrowed per-event in the handler. `event_id` is what
// recordWebhookEventIfNew dedupes on — per iBluSend's docs, delivery is
// at-least-once and event_id is "unique per occurrence and stable across
// retries," unlike data.message_id, which identifies the message itself,
// not the delivery attempt.

export const ibluSendWebhookEnvelopeSchema = z.object({
  event: z.string().min(1),
  event_id: z.string().min(1),
  timestamp: z.string().min(1),
  api_version: z.string().min(1).optional(),
  data: z.record(z.string(), z.unknown()),
});
export type IbluSendWebhookEnvelope = z.infer<typeof ibluSendWebhookEnvelopeSchema>;

export const ibluSendMessageReceivedDataSchema = z.object({
  message_id: z.string().min(1),
  phone_number: z.string().min(1),
  content: z.string().nullable().optional(),
  direction: z.string().min(1),
  service_type: z.string().min(1).optional(),
  media_urls: z.array(z.string()).nullable().optional(),
});
export type IbluSendMessageReceivedData = z.infer<typeof ibluSendMessageReceivedDataSchema>;
