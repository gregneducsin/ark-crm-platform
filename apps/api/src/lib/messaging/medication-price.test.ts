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
