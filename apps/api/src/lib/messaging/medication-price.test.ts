import { priceOfferFor, priceConfirmationText } from "./price-offer.js";
import type { BotPreviewRequestBody } from "./types.js";
import { describe, expect, it } from "vitest";
import { medicationPriceError } from "./medication-price.js";
const topics = ["semaglutide_pricing", "tirzepatide_pricing", "first_month_offer"];
describe("medication price binding", () => {
  it.each([
    "Semaglutide costs $225 for one month.",
    "$225 for semaglutide.",
    "Tirzepatide costs $169 for one month.",
    "Semaglutide is $225 and tirzepatide is $169.",
    "Semaglutide is $225.00.",
    "Semaglutide and tirzepatide cost $225.",
  ])("rejects mismatched or ambiguous quote: %s", text => {
    expect(medicationPriceError([text], topics)).not.toBeNull();
  });
  it("checks the follow-up using the medication stated in the reply", () => {
    expect(medicationPriceError(["Semaglutide is an option.", "Does $225 work?"], topics)).not.toBeNull();
  });
  it("does not let a wrong citation override the named medication", () => {
    expect(medicationPriceError(["Semaglutide is $225."], ["tirzepatide_pricing"])).not.toBeNull();
  });
  it("allows valid comparisons including price before product", () => {
    expect(medicationPriceError(["$169 for semaglutide and $225 for tirzepatide."], topics)).toBeNull();
  });
  it("allows discount and monthly-equivalent catalog figures", () => {
    expect(medicationPriceError(["Semaglutide is $270 total for 3 months, averaging $90 per month. With $40 off, the total is $230."], topics)).toBeNull();
  });
  it("allows a topic to identify an otherwise unnamed single product", () => {
    expect(medicationPriceError(["That plan is $90 per month."], ["semaglutide_pricing"])).toBeNull();
  });
  it("rejects unnamed ambiguous quotes when both topics are cited", () => {
    expect(medicationPriceError(["It costs $169."], topics)).not.toBeNull();
  });
});

describe("approved deterministic offers remain valid", () => {
  for (const product of ["semaglutide", "tirzepatide"] as const) {
    for (const plan of ["month_to_month","3_month","6_month"]) {
      for (const discounted of [false, true]) {
        it(product + " " + plan + " discount=" + discounted, () => {
          const body = { currentSlots: { selectedProduct: product, planLength: plan }, messages: [], promoOffered: discounted } as unknown as BotPreviewRequestBody;
          const offer = priceOfferFor(body, {}, discounted);
          expect(offer).not.toBeNull();
          expect(medicationPriceError([priceConfirmationText(offer!)], topics)).toBeNull();
        });
      }
    }
  }
});

 describe('plan and promotion binding',()=>{
 it('allows code and regular totals together without confusing their roles',()=>expect(medicationPriceError(['Semaglutide with MG25 costs $569 total for six months (regular $594).'],[...topics,'resume_code_mg25'])).toBeNull());
 it.each([
  'Semaglutide costs $169 total for the 6-month plan.',
  'Semaglutide costs $270 total for six months.',
  'Semaglutide costs $594 total for 3 months.',
  'Semaglutide costs $99 total for six months.',
  'Semaglutide costs $169 per month for six months.',
  'Semaglutide costs $594 total for 12 months.',
  'Semaglutide is $554 total for six months.',
  'Semaglutide with MG25 is $554 total for six months.',
  'Semaglutide with MG25 is $245 total for six months.',
 ])('rejects inconsistent plan: %s', text=>expect(medicationPriceError([text],[...topics,'resume_code_mg25'])).not.toBeNull());
 it('keeps the stated duration for the follow-up',()=>expect(medicationPriceError(['The semaglutide six-month plan.', 'The total is $169.'],topics)).not.toBeNull());
 it('allows the approved six-month average and total',()=>expect(medicationPriceError(['Semaglutide costs $594 total for six months, averaging $99 per month.'],topics)).toBeNull());
 it('allows the approved code total with the correct period',()=>expect(medicationPriceError(['Semaglutide with MG25 costs $569 total for six months.'],[...topics,'resume_code_mg25'])).toBeNull());
 it('requires the offer topic for a discounted total',()=>expect(medicationPriceError(['With $40 off, semaglutide costs $554 total for six months.'],['semaglutide_pricing'])).not.toBeNull());
 });
