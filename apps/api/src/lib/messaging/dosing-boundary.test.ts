import { describe, expect, it } from "vitest";
import { DOSING_DEFERRAL, hasDosingDetails, inboundDosingBoundary } from "./dosing-boundary.js";

function body(text: string, lastQuestion: string | null = null): Parameters<typeof inboundDosingBoundary>[0] {
  return { messages: [{ direction: "inbound", body: "I have used tirzepatide before." }, { direction: "inbound", body: text }], currentSlots: { selectedProduct: "tirzepatide" }, lastQuestion };
}

describe("Alexis's dosing boundary", () => {
  it.each(["4mg", "0.4mL", "400mcg", "400µg"])("catches compact dose notation: %s", dose => {
    expect(inboundDosingBoundary(body(`Can I take ${dose}?`))).toBe("review");
    expect(hasDosingDetails(`You can request ${dose}.`)).toBe(true);
  });
  it("retains a dosing question followed immediately by a pricing text", () => {
    const request = body("Can I restart at 4 mg?");
    expect(inboundDosingBoundary({ ...request, messages: [...request.messages, { direction: "inbound", body: "Also how much is it?" }] })).toBe("review");
  });
  it.each(["I was up to 8", "I was taking 6.5", "I used to be on 4", "I took 4 mg previously", "My dose was 4"])("defers a prior-dose statement without filling missing details: %s", text => {
    expect(inboundDosingBoundary(body(text))).toBe("history");
  });
  it("does not interpret an answer to an old dose question", () => {
    expect(inboundDosingBoundary(body("8", "What dose were you taking?"))).toBe("history");
    expect(inboundDosingBoundary(body("120", "What price works for you?"))).toBeNull();
  });
  it.each(["Can I take 4 mg?", "Is 4 mg okay?", "What dose should I use?", "I want to restart my dose", "Should I continue my dose?"])("routes dose decisions to clinical review: %s", text => {
    expect(inboundDosingBoundary(body(text))).toBe("review");
  });
  it.each(["The 3 month plan", "Is it $240 total?", "I was on 4 mg before. How much does it cost?", "120"])("lets nonclinical pricing continue: %s", text => {
    expect(inboundDosingBoundary(body(text))).toBeNull();
  });
  it.each(["You can request 8 mg, subject to provider review.", "Were you taking 8 milligrams?", "That is 40 units.", "Use one milliliter.", "You can continue at 8.", "You can request the same dose.", "Your dose can remain unchanged.", "Continue your dose.", "Your dose is 4."])("rejects numeric doses and continuation claims: %s", text => {
    expect(hasDosingDetails(text)).toBe(true);
  });
  it.each([DOSING_DEFERRAL, "Semaglutide is $120 for 1 month.", "The 3-month plan is $240 total.", "You can start on 3 months.", "Your provider decides the appropriate dose.", "Please provide prior prescription information during intake."])("allows safe enrollment and clinical deferral: %s", text => {
    expect(hasDosingDetails(text)).toBe(false);
  });
});
