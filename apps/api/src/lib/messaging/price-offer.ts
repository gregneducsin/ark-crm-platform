import type { BotPreviewRequestBody } from "./types.js";
import { paymentTimingParts } from "./payment-timing.js";
type Product = "semaglutide" | "tirzepatide";
type Plan = "month_to_month" | "3_month" | "6_month";
const PRICES = {
  semaglutide: { month_to_month: [169, 169], "3_month": [90, 270], "6_month": [99, 594] },
  tirzepatide: { month_to_month: [225, 225], "3_month": [170, 510], "6_month": [172, 1035] },
} as const;
export function selectedPlan(text: string): Plan | null {
  const answer = (paymentTimingParts(text)?.acceptance ?? text).trim().replace(/’/g, "'");
  const match = answer.match(/^(?:(?:yes|okay|ok)[, ]+)?(?:(?:i want|i'll take|i will take|i will go with|i'll go with|i choose|let's do|take|choose|go with)\s+)?(?:(?:the|a)\s+)?(1|one|3|three|6|six)[ .-]+months?(?:\s+plan)?(?:[,]?\s+please)?[.! ]*$/i);
  if (match) return /^(1|one)$/i.test(match[1]) ? "month_to_month" : /^(3|three)$/i.test(match[1]) ? "3_month" : "6_month";
  return /^(?:(?:i want|i'll take|i will take|i choose)\s+)?(?:the\s+)?month[ -]to[ -]month(?:\s+plan)?[.! ]*$/i.test(answer) ? "month_to_month" : null;
}
export function priceOfferFor(body: BotPreviewRequestBody, updates: Record<string, unknown>, promoOffered: boolean) {
  const product = updates.selectedProduct ?? body.currentSlots.selectedProduct;
  const last = body.messages.filter(m => m.direction === "inbound").at(-1)?.body ?? "";
  const plan = selectedPlan(last) ?? updates.planLength ?? body.currentSlots.planLength ?? "month_to_month";
  if (product !== "semaglutide" && product !== "tirzepatide") return null;
  if (plan !== "month_to_month" && plan !== "3_month" && plan !== "6_month") return null;
  const [monthly, regular] = PRICES[product as Product][plan as Plan];
  const discounted = body.promoOffered || promoOffered;
  return { product, plan, monthly, regular, total: regular - (discounted ? 40 : 0), discounted };
}
export function priceConfirmationText(offer: NonNullable<ReturnType<typeof priceOfferFor>>): string {
  const dollars = (value: number) => value.toLocaleString("en-US");
  const name = offer.product === "semaglutide" ? "Semaglutide" : "Tirzepatide";
  if (offer.plan === "month_to_month") return offer.discounted
    ? `${name} is $${offer.total} for the first month with the $40 offer, then $${offer.regular} per month.`
    : `${name} is $${offer.total} per month on the month-to-month plan.`;
  const months = offer.plan === "3_month" ? 3 : 6;
  if (offer.discounted) return `${name}'s ${months}-month plan is $${dollars(offer.total)} at signup with the $40 offer. The regular plan total is $${dollars(offer.regular)}, billed every ${months} months.`;
  return `${name}'s ${months}-month plan costs $${dollars(offer.total)} total, billed every ${months} months (about $${offer.monthly} per month on average, not monthly installments).`;
}
