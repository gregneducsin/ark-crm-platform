import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { confirmedTriggerLinkState } from "./trigger-link-state.js";
const raw = "synthetic_token-123";
const link = { tokenHash: createHash("sha256").update(raw).digest("hex"), clickedAt: null };
const body = `Resume: https://app.tryark.com/go/${raw}`;
describe("confirmed trigger link badges", () => {
  it.each(["sent", "delivered", "read"])("recognizes confirmed %s messages", (deliveryStatus) => {
    expect(confirmedTriggerLinkState([{ body, direction: "outbound", deliveryStatus }], [link])).toEqual({ sent: true, clicked: false });
  });
  it.each(["queued", "failed", "unknown", null])("does not label %s as sent", (deliveryStatus) => {
    expect(confirmedTriggerLinkState([{ body, direction: "outbound", deliveryStatus }], [link])).toEqual({ sent: false, clicked: false });
  });
  it("does not count inbound, generated-only, or another customer's links", () => {
    expect(confirmedTriggerLinkState([{ body, direction: "inbound", deliveryStatus: "delivered" }], [link]).sent).toBe(false);
    expect(confirmedTriggerLinkState([], [link]).sent).toBe(false);
    expect(confirmedTriggerLinkState([{ body, direction: "outbound", deliveryStatus: "sent" }], []).sent).toBe(false);
  });
  it("recognizes HTML trigger emails and recorded clicks", () => {
    expect(confirmedTriggerLinkState([{ body: `<a href="https://app.tryark.com/go/${raw}">Continue</a>`, direction: "outbound", deliveryStatus: "sent" }], [{ ...link, clickedAt: new Date() }])).toEqual({ sent: true, clicked: true });
  });
  it("does not let a newer unsent token erase a sent link's click", () => {
    expect(confirmedTriggerLinkState([{ body, direction: "outbound", deliveryStatus: "sent" }], [{ tokenHash: "unsent", clickedAt: null }, { ...link, clickedAt: new Date() }])).toEqual({ sent: true, clicked: true });
  });
});
