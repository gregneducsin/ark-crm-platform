import { and, eq, sql } from "drizzle-orm";
import {
  db,
  webhookEventsTable,
  customersTable,
  externalIdentitiesTable,
  purchasesTable,
  questionnaireEventsTable,
  failedPaymentEventsTable,
  type WebhookEvent,
} from "@luma/db";
import type {
  GhlLeadWebhookRequest,
  BaskOrderWebhookRequest,
  BaskQuestionnaireWebhookRequest,
  BaskPaymentFailedWebhookRequest,
  BaskPaymentSucceededWebhookRequest,
  BaskPaymentRefundedWebhookRequest,
  BaskPrescriptionWrittenWebhookRequest,
  BaskOrderShippedWebhookRequest,
} from "@luma/shared";
import { scheduleAbandonedCartOpener } from "./abandoned-cart.service.js";
import { scheduleAbandonedCartEmailSequence } from "./abandoned-cart-email.service.js";
import { sendMetaLeadOpener } from "./meta-lead.service.js";
import { scheduleMetaLeadEmailSequence } from "./meta-lead-email.service.js";
import {
  sendOrderReceivedOpener,
  sendRefillOrderReceivedNotice,
  handlePrescriptionWritten,
  handleOrderShipped,
  handlePaymentFailed,
  handleRefund,
} from "./order-fulfillment.service.js";
import { setCustomerSmsDnd, setCustomerEmailDnd, silenceOtherLeadsSharingPhone } from "./dnd.service.js";
import { normalizePhone } from "../lib/phone.js";
import { logger } from "../lib/logger.js";
import { notifySlack } from "../lib/slack.js";

/**
 * Case-insensitive exact email match — NOT ilike(), which treats `_` and `%`
 * in the pattern as live SQL wildcards. `_` in particular is an ordinary,
 * common character in an email local-part (john_doe@example.com), so an
 * ilike() lookup on a webhook-supplied email could match a completely
 * different real customer's email that merely fits the wildcard pattern,
 * misattributing one person's order/prescription/tracking data to another.
 * lower()-equality has no wildcard semantics at all.
 */
export function caseInsensitiveEmailEq(email: string) {
  return sql`lower(${customersTable.email}) = lower(${email})`;
}

// ── Shared idempotency + audit-log helpers ──────────────────────────────────

/**
 * Atomically claims a webhook delivery for processing. Returns null when the
 * caller should treat this as a no-op replay (return 200 without
 * reprocessing) — either it's already `processed`, or another in-flight
 * request is currently handling it (status `received`, received recently).
 *
 * Returns a claimed row (and RESETS status back to `received`) in two cases
 * beyond a genuinely first-ever delivery: the previous attempt ended in
 * `failed` (a transient error shouldn't permanently block every future
 * retry — the row existing was silently treated as "already handled" before
 * this fix, so the sender got a 200 and the real data never landed), or the
 * row has been stuck in `received` for more than 5 minutes (processing here
 * is synchronous within one HTTP request and normally finishes in well
 * under a second, so anything still `received` that long almost certainly
 * means the process crashed mid-request, not that it's still working).
 */
export async function recordWebhookEventIfNew(
  source: WebhookEvent["source"],
  externalEventId: string,
  rawPayload: unknown,
): Promise<{ id: string } | null> {
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO webhook_events (source, external_event_id, raw_payload)
    VALUES (${source}, ${externalEventId}, ${JSON.stringify(rawPayload)}::jsonb)
    ON CONFLICT (source, external_event_id) DO UPDATE
    SET status = 'received', raw_payload = excluded.raw_payload, error_message = null
    WHERE webhook_events.status = 'failed'
       OR (webhook_events.status = 'received' AND webhook_events.received_at < now() - interval '5 minutes')
    RETURNING id
  `);
  const row = result.rows[0];
  return row ? { id: row.id } : null;
}

export async function markWebhookEventProcessed(id: string, personId?: string): Promise<void> {
  await db
    .update(webhookEventsTable)
    .set({ status: "processed", processedAt: new Date(), ...(personId ? { personId } : {}) })
    .where(eq(webhookEventsTable.id, id));
}

export async function markWebhookEventFailed(id: string, errorMessage: string): Promise<void> {
  const [row] = await db
    .update(webhookEventsTable)
    .set({ status: "failed", processedAt: new Date(), errorMessage })
    .where(eq(webhookEventsTable.id, id))
    .returning({ source: webhookEventsTable.source });
  if (row) {
    // Short and identifier-only, not the raw error — errorMessage is
    // already stored on the webhook_events row and captured by the caller's
    // own structured logging; Slack is a ping to go look, not the full
    // diagnostic dump (which could also be arbitrarily long, e.g. a raw
    // Postgres error's multi-line detail/hint text).
    void notifySlack(`Webhook failed — ${row.source}`);
  }
}

/**
 * Matches an existing customer by (system, externalId) first, falling back
 * to a case-insensitive email match, and creates a new customer if neither
 * matches. Links the external identity either way (idempotent) so future
 * webhooks for the same external contact resolve directly.
 */
export async function findOrCreateCustomerByExternalIdentity(params: {
  system: string;
  externalId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  leadReceivedDate: string;
  leadType?: string;
}): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const [byIdentity] = await tx
      .select({ personId: externalIdentitiesTable.personId })
      .from(externalIdentitiesTable)
      .where(and(eq(externalIdentitiesTable.system, params.system), eq(externalIdentitiesTable.externalId, params.externalId)));
    if (byIdentity) return { id: byIdentity.personId };

    const [byEmail] = await tx.select({ id: customersTable.id }).from(customersTable).where(caseInsensitiveEmailEq(params.email));

    const customerId = byEmail
      ? byEmail.id
      : (
          await tx
            .insert(customersTable)
            .values({
              firstName: params.firstName ?? "Unknown",
              lastName: params.lastName ?? "Unknown",
              email: params.email,
              phone: params.phone ? normalizePhone(params.phone) : params.phone,
              leadReceivedDate: params.leadReceivedDate,
              leadType: params.leadType ?? "Other / Unknown",
              leadCreatedAt: new Date(),
            })
            .returning({ id: customersTable.id })
        )[0]!.id;

    await tx
      .insert(externalIdentitiesTable)
      .values({ personId: customerId, system: params.system, externalId: params.externalId })
      .onConflictDoNothing({ target: [externalIdentitiesTable.system, externalIdentitiesTable.externalId] });

    return { id: customerId };
  });
}

/** Best-effort match only — does not create a customer. Used by the
 * payment-failed handler, since a failed payment isn't itself a lead
 * signal strong enough to justify creating a new customer record. */
async function tryFindCustomerByExternalIdentityOrEmail(system: string, externalId: string, email?: string): Promise<string | undefined> {
  const [byIdentity] = await db
    .select({ personId: externalIdentitiesTable.personId })
    .from(externalIdentitiesTable)
    .where(and(eq(externalIdentitiesTable.system, system), eq(externalIdentitiesTable.externalId, externalId)));
  if (byIdentity) return byIdentity.personId;

  if (email) {
    const [byEmail] = await db.select({ id: customersTable.id }).from(customersTable).where(caseInsensitiveEmailEq(email));
    if (byEmail) return byEmail.id;
  }
  return undefined;
}

// ── Per-source handlers ─────────────────────────────────────────────────────

const occurredDate = (iso: string) => iso.slice(0, 10);

/** The exact leadType value GHL sends for a Meta (Facebook/Instagram) lead-gen form submission. */
const META_FORM_FILL_LEAD_TYPE = "meta form fill";
const isMetaFormFillLead = (leadType?: string): boolean => (leadType ?? "").trim().toLowerCase() === META_FORM_FILL_LEAD_TYPE;

export async function handleGhlLeadWebhook(payload: GhlLeadWebhookRequest): Promise<{ duplicate: boolean }> {
  const recorded = await recordWebhookEventIfNew("ghl_lead", payload.eventId, payload);
  if (!recorded) return { duplicate: true };

  try {
    const occurredAt = payload.occurredAt ?? new Date().toISOString();
    const { id: customerId } = await findOrCreateCustomerByExternalIdentity({
      system: "ghl",
      externalId: payload.contactId,
      email: payload.email,
      firstName: payload.firstName,
      lastName: payload.lastName,
      phone: payload.phone,
      leadReceivedDate: occurredDate(occurredAt),
      leadType: payload.leadType,
    });

    // Meta form-fill leads are cold outreach — respond as fast as possible,
    // so the opener fires synchronously on this same request, not off a
    // scheduled sweep like the abandoned-cart trigger.
    if (isMetaFormFillLead(payload.leadType)) {
      await sendMetaLeadOpener(customerId);
      await scheduleMetaLeadEmailSequence(customerId);
    }

    await markWebhookEventProcessed(recorded.id, customerId);
  } catch (err) {
    await markWebhookEventFailed(recorded.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { duplicate: false };
}

// payload.isFirstTimeOrder is `boolean | string | undefined` — see the
// comment on baskOrderWebhookRequestSchema for why the string variant isn't
// coerced in the schema itself. Confirmed against a real Zapier payload that
// the string form can be capitalized Python-style ("False"/"True"), so this
// compares case-insensitively rather than against a fixed "true"/"false".
function parseIsFirstOrder(value: boolean | string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : value.trim().toLowerCase() === "true";
}

export async function handleBaskOrderWebhook(payload: BaskOrderWebhookRequest): Promise<{ duplicate: boolean }> {
  const recorded = await recordWebhookEventIfNew("bask_order", payload.eventId, payload);
  if (!recorded) return { duplicate: true };

  try {
    const purchaseDate = occurredDate(payload.purchasedAt);
    const amountPaid = typeof payload.amountPaid === "number" ? payload.amountPaid.toFixed(2) : payload.amountPaid;

    const { id: customerId } = await findOrCreateCustomerByExternalIdentity({
      system: "bask",
      externalId: payload.externalPersonId,
      email: payload.email,
      firstName: payload.firstName,
      lastName: payload.lastName,
      phone: payload.phone,
      leadReceivedDate: purchaseDate,
    });

    let isFirstOrder = false;
    await db.transaction(async (tx) => {
      // Lock the customer row so two near-simultaneous order webhooks for the
      // same customer can't both read "no earlier purchase" and both classify
      // as first_order — see the identical comment on createPurchase.
      await tx.select({ id: customersTable.id }).from(customersTable).where(eq(customersTable.id, customerId)).for("update");

      const [earlier] = await tx
        .select({ id: purchasesTable.id })
        .from(purchasesTable)
        .where(eq(purchasesTable.customerId, customerId));

      // Bask's own isFirstOrder flag is the source of truth when it's
      // present — it reflects the customer's real order history on Bask's
      // side, which can predate or diverge from ours (e.g. a customer who
      // ordered before this webhook existed looks like a "first order" by
      // our own "does an earlier purchase row exist" check even though
      // they're a real repeat customer). Fall back to that DB-derived check
      // only when Bask doesn't send the flag.
      isFirstOrder = parseIsFirstOrder(payload.isFirstTimeOrder) ?? !earlier;

      // The partial unique index (purchases_customer_first_order_key) forbids
      // a second "first_order" row for the same customer, and a customer we
      // already have purchase history for shouldn't get a "your first
      // order!" welcome opener regardless of who's asserting otherwise. If
      // isFirstOrder is true here while an earlier row already exists (e.g.
      // a mismatched external-identity match resolving two Bask customers to
      // the same row), that's a real data conflict — fail safe as
      // "recurring" for both the stored classification and the opener
      // decision below, instead of crashing on the unique-index violation.
      if (isFirstOrder && earlier) {
        isFirstOrder = false;
        logger.warn(
          { customerId },
          "Bask reported a first order for a customer we already have purchase history for — treating as recurring to avoid a duplicate first_order row; check this customer's external-identity match.",
        );
      }

      await tx.insert(purchasesTable).values({
        customerId,
        purchaseDate,
        orderNumber: payload.orderId,
        productName: payload.productName,
        amountPaid,
        ecommerceOrderId: payload.ecommerceOrderId ?? payload.transactionId,
        orderClassification: isFirstOrder ? "first_order" : "recurring",
        orderClassificationSource: "bask",
      });
    });

    // A purchase is treated as fresh consent to be messaged again, on both
    // channels independently — cleared before the opener below so a
    // previously opted-out customer's order confirmation isn't itself
    // blocked by a now-stale DND flag. Applies to every order, new or
    // recurring — a refill is exactly as much fresh consent as a first order.
    await setCustomerSmsDnd(customerId, false);
    await setCustomerEmailDnd(customerId, false);
    // The mirror image: any other, still-unpurchased lead sharing this same
    // phone number stops getting marketing texts/emails — see
    // silenceOtherLeadsSharingPhone's docstring.
    await silenceOtherLeadsSharingPhone(customerId);

    // Sophie's opening message fires the moment the order lands — instant,
    // same as the Meta lead opener, not a scheduled sweep. A genuine first
    // order gets the "doctor is reviewing it" welcome copy; re-sending that
    // same welcome to a recurring/refill order would read as broken, so it
    // gets its own refill-specific notice instead — not silence.
    if (isFirstOrder) {
      await sendOrderReceivedOpener(customerId);
    } else {
      await sendRefillOrderReceivedNotice(customerId);
    }

    await markWebhookEventProcessed(recorded.id, customerId);
  } catch (err) {
    await markWebhookEventFailed(recorded.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { duplicate: false };
}

export async function handleBaskPrescriptionWrittenWebhook(payload: BaskPrescriptionWrittenWebhookRequest): Promise<{ duplicate: boolean }> {
  const recorded = await recordWebhookEventIfNew("bask_prescription_written", payload.eventId, payload);
  if (!recorded) return { duplicate: true };

  try {
    const occurredAt = payload.occurredAt ?? new Date().toISOString();
    const { id: customerId } = await findOrCreateCustomerByExternalIdentity({
      system: "bask",
      externalId: payload.externalPersonId,
      email: payload.email,
      firstName: payload.firstName,
      lastName: payload.lastName,
      phone: payload.phone,
      leadReceivedDate: occurredDate(occurredAt),
    });

    await handlePrescriptionWritten(customerId);

    await markWebhookEventProcessed(recorded.id, customerId);
  } catch (err) {
    await markWebhookEventFailed(recorded.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { duplicate: false };
}

export async function handleBaskOrderShippedWebhook(payload: BaskOrderShippedWebhookRequest): Promise<{ duplicate: boolean }> {
  // Bask's real shipping event doesn't include an eventId — synthesize a
  // stable one from externalPersonId + trackingNumber so redelivery of the
  // same shipment notice still dedupes, while a different tracking number
  // for the same person (a separate refill shipment) is treated as new.
  const eventId = payload.eventId ?? `${payload.externalPersonId}:${payload.trackingNumber}`;
  const recorded = await recordWebhookEventIfNew("bask_order_shipped", eventId, payload);
  if (!recorded) return { duplicate: true };

  try {
    // Bask's real shipping event also doesn't include email — but by the
    // time an order ships, the customer should already exist from the order
    // webhook, so this only ever needs to find the existing match, never
    // create one (findOrCreateCustomerByExternalIdentity would fail here
    // anyway, since customers.email is NOT NULL and this event has none).
    const customerId = await tryFindCustomerByExternalIdentityOrEmail("bask", payload.externalPersonId, payload.email);
    if (!customerId) {
      throw new Error(`bask_order_shipped: no existing customer found for externalPersonId ${payload.externalPersonId}`);
    }

    await handleOrderShipped(customerId, payload.trackingNumber);

    await markWebhookEventProcessed(recorded.id, customerId);
  } catch (err) {
    await markWebhookEventFailed(recorded.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { duplicate: false };
}

// Only used at customer-creation time (findOrCreateCustomerByExternalIdentity
// never overwrites leadType on an existing match) — reflects the funnel
// stage of whichever questionnaire event happens to arrive first for a
// person who isn't already a customer.
const BASK_QUESTIONNAIRE_LEAD_TYPES: Record<BaskQuestionnaireWebhookRequest["status"], string> = {
  started: "Bask questionnaire started",
  abandoned: "Bask abandoned cart",
  submitted: "Bask questionnaire submitted",
};

export async function handleBaskQuestionnaireWebhook(payload: BaskQuestionnaireWebhookRequest): Promise<{ duplicate: boolean }> {
  const recorded = await recordWebhookEventIfNew("bask_questionnaire", payload.eventId, payload);
  if (!recorded) return { duplicate: true };

  try {
    const occurredAt = payload.occurredAt ?? new Date().toISOString();
    const { id: customerId } = await findOrCreateCustomerByExternalIdentity({
      system: "bask",
      externalId: payload.externalPersonId,
      email: payload.email,
      firstName: payload.firstName,
      lastName: payload.lastName,
      phone: payload.phone,
      leadReceivedDate: occurredDate(occurredAt),
      leadType: BASK_QUESTIONNAIRE_LEAD_TYPES[payload.status],
    });

    const now = new Date(occurredAt);
    const [event] = await db
      .insert(questionnaireEventsTable)
      .values({
        personId: customerId,
        questionnaireId: payload.questionnaireId,
        status: payload.status,
        externalPersonId: payload.externalPersonId,
        startedAt: payload.status === "started" ? now : undefined,
        abandonedAt: payload.status === "abandoned" ? now : undefined,
        lastEventAt: now,
      })
      .onConflictDoUpdate({
        target: [questionnaireEventsTable.personId, questionnaireEventsTable.questionnaireId],
        set: {
          status: payload.status,
          lastEventAt: now,
          ...(payload.status === "abandoned" ? { abandonedAt: now } : {}),
          updatedAt: new Date(),
        },
      })
      .returning({ id: questionnaireEventsTable.id });

    // Arms the first Alexis SMS outreach 10 minutes from now, plus the
    // independent 4-step email nurture sequence (opener/urgency/educational/
    // plan_comparison — see abandoned-cart-email.service.ts). Both are
    // idempotent per questionnaire event, so a duplicate "abandoned"
    // delivery for the same questionnaire can't double-schedule either.
    if (payload.status === "abandoned") {
      await scheduleAbandonedCartOpener(customerId, event.id);
      await scheduleAbandonedCartEmailSequence(customerId, event.id);
    }

    await markWebhookEventProcessed(recorded.id, customerId);
  } catch (err) {
    await markWebhookEventFailed(recorded.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { duplicate: false };
}

// Bask's failed-payment webhook sends `amount` as a bare integer of CENTS
// (confirmed against a real delivery: a $510.00 charge arrived as "51000"),
// unlike every other amount field in this app, which is dollars-and-cents.
// The schema's regex also accepts an already-decimal value, so only convert
// when there's no decimal point — a value that already arrives correctly
// formatted isn't silently divided by 100 a second time.
function normalizeFailedPaymentAmount(amount: string | undefined): string | undefined {
  if (amount === undefined || amount.includes(".")) return amount;
  return (Number(amount) / 100).toFixed(2);
}

export async function handleBaskPaymentFailedWebhook(payload: BaskPaymentFailedWebhookRequest): Promise<{ duplicate: boolean }> {
  const recorded = await recordWebhookEventIfNew("bask_payment_failed", payload.eventId, payload);
  if (!recorded) return { duplicate: true };

  try {
    const customerId = await tryFindCustomerByExternalIdentityOrEmail("bask", payload.externalPersonId, payload.email);

    await db.insert(failedPaymentEventsTable).values({
      externalEventId: payload.eventId,
      transactionId: payload.transactionId,
      personId: customerId,
      externalPersonId: payload.externalPersonId,
      amount: normalizeFailedPaymentAmount(payload.amount),
      failureDate: new Date(payload.failureDate),
      paymentMethodType: payload.paymentMethodType,
      cardBrand: payload.cardBrand,
      cardLast4: payload.cardLast4,
      transactionResponse: payload.transactionResponse,
      sourceStatus: payload.sourceStatus,
      testMode: payload.testMode ?? false,
      rawPayload: payload,
    });

    // Correct the record and notify the customer — handleBaskOrderWebhook
    // already marked the purchase "completed" and sent the "we received
    // your order" notice the instant the order landed, before payment was
    // confirmed. Correlated via ecommerceOrderId (has a unique index),
    // which handleBaskOrderWebhook populates from the order webhook's own
    // ecommerceOrderId, falling back to ITS transactionId — matching this
    // payload's transactionId is the best available signal that the two
    // independent Bask webhooks refer to the same underlying transaction,
    // not yet confirmed against a real pair of Bask payloads for the same
    // order (same "SPECULATIVE, confirm against the real payload" caveat as
    // this file's other Bask webhook assumptions).
    if (customerId) {
      const [purchase] = await db
        .select({ id: purchasesTable.id, status: purchasesTable.status, orderClassification: purchasesTable.orderClassification })
        .from(purchasesTable)
        .where(and(eq(purchasesTable.customerId, customerId), eq(purchasesTable.ecommerceOrderId, payload.transactionId)));

      if (purchase && purchase.status === "completed") {
        await db.update(purchasesTable).set({ status: "payment_failed" }).where(eq(purchasesTable.id, purchase.id));
        await handlePaymentFailed(customerId, purchase.orderClassification === "first_order");
      } else if (!purchase) {
        logger.warn({ customerId, transactionId: payload.transactionId }, "payment-failed webhook: no matching purchase found to correct — recorded for reporting only");
      }
    } else {
      logger.warn({ transactionId: payload.transactionId }, "payment-failed webhook: could not resolve a customer — recorded for reporting only");
    }

    await markWebhookEventProcessed(recorded.id, customerId);
  } catch (err) {
    await markWebhookEventFailed(recorded.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { duplicate: false };
}

/**
 * Confirms a payment succeeded on an existing order — a retry after a card
 * update, or (less commonly) the normal first-attempt confirmation. Purely a
 * data correction, no customer notification: if handleBaskPaymentFailedWebhook
 * had earlier corrected the matching purchase to "payment_failed", this flips
 * it back to "completed" and auto-resolves the corresponding
 * failed_payment_events row, recording which purchase/transaction recovered
 * it — the same recoveredPurchaseId/recoveredTransactionId columns the
 * Failed Payments page's manual "Resolve" action leaves untouched, since a
 * staff member resolving by hand isn't necessarily citing a specific
 * transaction the way this webhook always can.
 *
 * A no-op (recorded for reporting only) when there's no matching purchase or
 * no open failed-payment row — e.g. Bask sending this as routine
 * confirmation for a payment that never failed in the first place.
 */
export async function handleBaskPaymentSucceededWebhook(payload: BaskPaymentSucceededWebhookRequest): Promise<{ duplicate: boolean }> {
  const recorded = await recordWebhookEventIfNew("bask_payment_succeeded", payload.eventId, payload);
  if (!recorded) return { duplicate: true };

  try {
    const customerId = await tryFindCustomerByExternalIdentityOrEmail("bask", payload.externalPersonId, payload.email);

    if (customerId) {
      const [purchase] = await db
        .select({ id: purchasesTable.id, status: purchasesTable.status })
        .from(purchasesTable)
        .where(and(eq(purchasesTable.customerId, customerId), eq(purchasesTable.ecommerceOrderId, payload.transactionId)));

      if (purchase && purchase.status === "payment_failed") {
        await db.update(purchasesTable).set({ status: "completed" }).where(eq(purchasesTable.id, purchase.id));

        await db
          .update(failedPaymentEventsTable)
          .set({
            resolutionStatus: "resolved",
            resolvedAt: new Date(),
            recoveredPurchaseId: purchase.id,
            recoveredTransactionId: payload.transactionId,
          })
          .where(and(eq(failedPaymentEventsTable.transactionId, payload.transactionId), eq(failedPaymentEventsTable.resolutionStatus, "open")));
      } else if (!purchase) {
        logger.warn({ customerId, transactionId: payload.transactionId }, "payment-succeeded webhook: no matching purchase found — recorded for reporting only");
      }
    } else {
      logger.warn({ transactionId: payload.transactionId }, "payment-succeeded webhook: could not resolve a customer — recorded for reporting only");
    }

    await markWebhookEventProcessed(recorded.id, customerId);
  } catch (err) {
    await markWebhookEventFailed(recorded.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { duplicate: false };
}

/**
 * Flips a completed purchase to "refunded" and flags the support
 * conversation for a person to review — no automated customer notification
 * (see handleRefund's own docstring for why). A no-op beyond recording the
 * event (for reporting only) when there's no matching customer or no
 * "completed" purchase to correct — e.g. it was already refunded, or is in
 * some other state a refund shouldn't silently overwrite.
 */
export async function handleBaskPaymentRefundedWebhook(payload: BaskPaymentRefundedWebhookRequest): Promise<{ duplicate: boolean }> {
  const recorded = await recordWebhookEventIfNew("bask_payment_refunded", payload.eventId, payload);
  if (!recorded) return { duplicate: true };

  try {
    // No email field in this payload (unlike payment-failed/succeeded) —
    // matching is externalPersonId only, no email fallback.
    const customerId = await tryFindCustomerByExternalIdentityOrEmail("bask", payload.externalPersonId);
    const amount = normalizeFailedPaymentAmount(payload.amount);

    if (customerId) {
      const [purchase] = await db
        .select({ id: purchasesTable.id, status: purchasesTable.status })
        .from(purchasesTable)
        .where(and(eq(purchasesTable.customerId, customerId), eq(purchasesTable.ecommerceOrderId, payload.transactionId)));

      if (purchase && purchase.status === "completed") {
        await db.update(purchasesTable).set({ status: "refunded" }).where(eq(purchasesTable.id, purchase.id));
        await handleRefund(customerId, payload.transactionId, amount);
      } else if (!purchase) {
        logger.warn({ customerId, transactionId: payload.transactionId }, "payment-refunded webhook: no matching purchase found — recorded for reporting only");
      } else {
        logger.warn({ customerId, transactionId: payload.transactionId, status: purchase.status }, "payment-refunded webhook: matching purchase is not 'completed' — recorded for reporting only");
      }
    } else {
      logger.warn({ transactionId: payload.transactionId }, "payment-refunded webhook: could not resolve a customer — recorded for reporting only");
    }

    await markWebhookEventProcessed(recorded.id, customerId);
  } catch (err) {
    await markWebhookEventFailed(recorded.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return { duplicate: false };
}
