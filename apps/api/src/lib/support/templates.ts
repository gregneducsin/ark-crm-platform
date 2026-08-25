/**
 * Fixed, pre-approved messages for Sophie's post-purchase support flow. Every
 * one of these is a status update fired off a real webhook event, not
 * AI-drafted — proactive outbound messages don't have an inbound message to
 * react to, so there's nothing for the guardrail loop to validate against;
 * the fixed approved text is the guardrail here. Same reasoning as Alexis's
 * follow-up-templates.ts.
 */

export function renderOrderReceivedMessage(firstName: string): string {
  const name = firstName.trim() || "there";
  return (
    `Hello ${name}, this is Sophie on the doctor support side. It looks like we received your order and the doctor is reviewing it now. ` +
    "If they have any further questions they will reach out in the patient portal, https://patient.tryark.com/login\n\n" +
    "We will update you once the prescription is written and sent to the pharmacy."
  );
}

export function renderRefillOrderReceivedMessage(firstName: string): string {
  const name = firstName.trim() || "there";
  return (
    `Hi ${name}, this is Sophie on the doctor support side. We've received your refill order and it's being processed now. ` +
    "If you have any questions in the meantime, you can check your patient portal, https://patient.tryark.com/login\n\n" +
    "We will update you once it ships."
  );
}

export function renderPrescriptionWrittenMessage(firstName: string): string {
  const name = firstName.trim() || "there";
  return `Hi ${name}, good news, the doctor has written your prescription and it's on its way to the pharmacy. We'll let you know as soon as it ships.`;
}

export function renderOrderShippedMessage(firstName: string, trackingNumber: string): string {
  const name = firstName.trim() || "there";
  return `Hi ${name}, your order has shipped. Your tracking number is ${trackingNumber}.`;
}

export function renderReviewRequestMessage(firstName: string): string {
  const name = firstName.trim() || "there";
  return `Hi ${name}, this is Sophie with Ark Health. Now that you've had a chance to receive your medication, how has your experience with us been so far?`;
}

/**
 * Fired from handlePaymentFailed when a bask_payment_failed webhook arrives
 * — correcting course after handleBaskOrderWebhook already sent the
 * "we received your order" message the moment the order landed, before
 * payment was actually confirmed. Two variants, owner-specified: a first
 * order goes straight to "reply and we'll help," since there's no existing
 * relationship to check in on — a recurring/refill order asks first whether
 * they still want to move forward, since that's a real yes/no question for
 * an existing patient rather than an assumed "of course."
 */
export function renderPaymentFailedFirstOrderMessage(firstName: string): string {
  const name = firstName.trim() || "there";
  return `Hi ${name}, this is Sophie with Ark Health. We weren't able to process the payment for your order, so we can't move forward with it yet. Reply here and we'll get your payment sorted.`;
}

export function renderPaymentFailedRecurringMessage(firstName: string): string {
  const name = firstName.trim() || "there";
  return `Hi ${name}, this is Sophie with Ark Health. We weren't able to process the payment for your refill. Are you still interested in moving forward with it? Reply here and let us know.`;
}
