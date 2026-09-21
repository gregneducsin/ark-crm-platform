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

// Bask sends bare JSON numbers for at least some ID fields when configured
// to POST directly (no Zapier remap in front of it) — confirmed against a
// real Luma delivery on the abandoned-session equivalent (sessionId/
// patientId/questionnaireId). Applied to every Bask ID-shaped field below
// on the assumption the same holds here until a real direct delivery
// confirms otherwise per event; accepts either shape and normalizes to a
// string, since everything downstream (externalId lookups, unique indexes)
// treats these as text.
const idLike = z.union([z.string().min(1), z.number()]).transform((v) => String(v));

export const baskOrderWebhookRequestSchema = z
  .object({
    eventId: idLike,
    externalPersonId: idLike,
    email: z.string().email(),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    phone: z.string().min(1).optional(),
    // Bask's own field name — matches its native payload, not our internal
    // purchases.orderNumber column name. The handler maps orderId -> orderNumber.
    orderId: idLike,
    productName: z.string().min(1),
    // Bask sends this as a JSON number; other sources may send a formatted
    // string. The handler normalizes either to a fixed 2-decimal string.
    amountPaid: z.union([z.string().regex(/^\d+(\.\d{1,2})?$/), z.number().nonnegative()]),
    // A single full timestamp — the handler derives both the purchase date
    // (date-only) and the webhook-event occurred date from this one field,
    // since Bask only provides one timestamp, not two.
    purchasedAt: z.string().datetime(),
    ecommerceOrderId: idLike.optional(),
    // Bask's own transaction identifier — used as ecommerceOrderId when that
    // field isn't separately provided.
    transactionId: idLike.optional(),
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
  eventId: idLike,
  externalPersonId: idLike,
  email: z.string().email(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  questionnaireId: idLike,
  status: z.enum(["started", "abandoned", "submitted"]),
  // Optional because some source integrations (e.g. a Zapier relay in front
  // of Bask) don't forward a timestamp at all — the handler defaults this to
  // the time the webhook was received rather than requiring the caller to
  // manufacture one.
  occurredAt: z.string().datetime().optional(),
});
export type BaskQuestionnaireWebhookRequest = z.infer<typeof baskQuestionnaireWebhookRequestSchema>;

// ── Bask "new patient" webhook ──────────────────────────────────────────────
// Fires the moment someone starts a brand-new questionnaire — earlier than
// started/abandoned/submitted, and the only Bask event that reliably carries
// a questionnaireId for a person who goes straight to checkout without ever
// abandoning (see handleBaskQuestionnaireNewPatientWebhook). Same shape as
// the regular questionnaire webhook minus `status`, since this always means
// "just started."
export const baskQuestionnaireNewPatientWebhookRequestSchema = z.object({
  eventId: z.string().min(1),
  externalPersonId: z.string().min(1),
  email: z.string().email(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  questionnaireId: z.string().min(1),
  occurredAt: z.string().datetime().optional(),
});
export type BaskQuestionnaireNewPatientWebhookRequest = z.infer<typeof baskQuestionnaireNewPatientWebhookRequestSchema>;

// ── Bask "abandoned session" webhook ────────────────────────────────────────
// Bask's own "abandonedSession" event, configured directly (no Zapier relay
// in front of it) — its webhook body builder only offers Bask's own data
// tokens (patientId, patientFirstName, sessionId, questionnaireId, etc.),
// with no way to also send a literal "abandoned" string for `status`. Same
// shape as the regular questionnaire webhook minus `status`, mirroring
// baskQuestionnaireNewPatientWebhookRequestSchema above — this event type
// always means "abandoned" by definition, so there's nothing to ask Bask to
// tell us (see handleBaskQuestionnaireAbandonedWebhook).
//
// Confirmed against a real Luma delivery: Bask sends sessionId/patientId/
// questionnaireId as bare JSON numbers here, not strings — idLike (defined
// above) accepts either and normalizes to a string, since everything
// downstream (externalId lookups, the questionnaire_events unique index)
// treats these as text.

export const baskQuestionnaireAbandonedWebhookRequestSchema = z.object({
  eventId: idLike,
  externalPersonId: idLike,
  email: z.string().email(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  questionnaireId: idLike,
  occurredAt: z.string().datetime().optional(),
});
export type BaskQuestionnaireAbandonedWebhookRequest = z.infer<typeof baskQuestionnaireAbandonedWebhookRequestSchema>;

// ── Bask payment-failed webhook ────────────────────────────────────────────────

export const baskPaymentFailedWebhookRequestSchema = z.object({
  eventId: idLike,
  transactionId: idLike,
  externalPersonId: idLike,
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
  eventId: idLike,
  transactionId: idLike,
  externalPersonId: idLike,
  email: z.string().email().optional(),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  succeededAt: z.string().datetime().optional(),
});
export type BaskPaymentSucceededWebhookRequest = z.infer<typeof baskPaymentSucceededWebhookRequestSchema>;

// ── Bask payment-refunded webhook ───────────────────────────────────────────────
//
// Bask's own event is `{ type: "paymentRefunded", data: { patientId,
// transactionId, amount, status, transactionResponse, date, paymentMethod,
// testMode, sessionId, treatmentId } }` (owner-supplied, confirmed real on
// Luma — same Bask platform) — no eventId of its own
// (handleBaskPaymentRefundedWebhook synthesizes one, same pattern as
// handleBaskOrderShippedWebhook), and no email field, so customer matching
// is by externalPersonId only, no email fallback. Field names below are
// this app's internal flat shape, not Bask's raw nested envelope directly —
// the route (bask-payment-refunded.routes.ts) remaps `data.patientId` ->
// `externalPersonId`, `data.date` -> `refundDate`, `data.paymentMethod` ->
// `paymentMethodType` after unwrapping the `{ type, data }` envelope and
// before validating here, since Bask's own webhook builder has no way to
// rename fields for us the way the old Zap remap did.
//
// `amount`'s cents-vs-dollars format is unconfirmed for this specific event
// (bask-payment-failed's `amount` arrives as bare cents, bask-payment-
// succeeded's arrives as dollars — the two other Bask payment webhooks
// disagree with each other) — apply the same conservative
// cents-if-no-decimal-point conversion bask-payment-failed uses until a
// real delivery confirms which format this one actually sends. Same
// caveat for `refundDate`'s exact string format (assumed ISO datetime,
// unconfirmed) — check both against a real direct-from-Bask delivery.
export const baskPaymentRefundedWebhookRequestSchema = z.object({
  eventId: idLike.optional(),
  transactionId: idLike,
  externalPersonId: idLike, // Bask's "data.patientId"
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  status: z.string().optional(),
  transactionResponse: z.string().optional(),
  refundDate: z.string().datetime().optional(), // Bask's "data.date"
  paymentMethodType: z.string().optional(), // Bask's "data.paymentMethod"
  testMode: z.boolean().optional(),
  sessionId: idLike.optional(),
  treatmentId: idLike.optional(),
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
  eventId: idLike,
  externalPersonId: idLike, // Bask's "Data Patient Id"
  email: z.string().email(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  prescriptionId: idLike.optional(),
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
  eventId: idLike.optional(),
  externalPersonId: idLike, // Bask's "Data Patient Id"
  email: z.string().email().optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  orderId: idLike.optional(),
  orderNumber: idLike.optional(),
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

// message.failed's real field shape hasn't been confirmed against a live
// delivery the way message.received's was above — message_id is required
// since every other iBluSend event uses that same field name for the
// message it concerns, but this deliberately doesn't require any other
// field (error/reason code, phone number, etc.) since we don't know their
// real names yet; handleIbluSendWebhook only needs message_id to look up
// which outbound row this refers to. Worth checking against a real
// message.failed delivery once one arrives, the same way message.received
// was confirmed.
export const ibluSendMessageFailedDataSchema = z.object({
  message_id: z.string().min(1),
});
export type IbluSendMessageFailedData = z.infer<typeof ibluSendMessageFailedDataSchema>;
