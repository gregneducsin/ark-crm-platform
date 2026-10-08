import { describe, it, expect } from "vitest";
import { renderConcernFollowUp } from "./concern-follow-up.js";
describe("known concern follow-ups", () => {
  it.each(["It's too expensive", "I can’t afford that", "My budget is tight", "I cannot pay until Friday"])("acknowledges budget/timing: %s", body => {
    const result = renderConcernFollowUp("Test", [body]);
    expect(result).toContain("cost or payment timing");
    expect(result).not.toMatch(/holding you back|approved|guaranteed|\$/i);
  });
  it.each(["Where do I pay?", "I haven't received the email", "The checkout has an error", "I cannot find the form"])("acknowledges checkout: %s", body => {
    expect(renderConcernFollowUp("Test", [body])).toContain("form or checkout");
  });
  it("keeps the concern across short acknowledgments", () => {
    expect(renderConcernFollowUp("Test", ["Thanks", "The checkout has an error"])).toContain("checkout");
  });
  it("prefers the latest concern", () => {
    expect(renderConcernFollowUp("Test", ["Where do I pay?", "Too expensive"])).toContain("checkout");
  });
  it("does not revive a resolved concern or stale price slot", () => {
    expect(renderConcernFollowUp("Test", ["It's fixed", "Too expensive"], "price")).toBeNull();
  });
  it("uses the saved price objection when history does not contain it", () => {
    expect(renderConcernFollowUp("Test", ["Thanks"], "price")).toContain("cost was a concern");
  });
  it.each(["I received the email", "Thanks", "What state do you serve?"])("does not invent concerns: %s", body => {
    expect(renderConcernFollowUp("Test", [body])).toBeNull();
  });
});
