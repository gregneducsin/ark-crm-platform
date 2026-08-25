import { describe, it, expect } from "vitest";
import {
  renderOrderReceivedMessage,
  renderRefillOrderReceivedMessage,
  renderPrescriptionWrittenMessage,
  renderOrderShippedMessage,
  renderReviewRequestMessage,
  renderPaymentFailedFirstOrderMessage,
  renderPaymentFailedRecurringMessage,
} from "./templates.js";

describe("renderOrderReceivedMessage", () => {
  it("introduces Sophie and mentions the portal link", () => {
    const text = renderOrderReceivedMessage("Jamie");
    expect(text).toContain("this is Sophie");
    expect(text).toContain("https://patient.tryark.com/login");
  });

  it("interpolates the first name, falling back to 'there' when blank", () => {
    expect(renderOrderReceivedMessage("Jamie")).toContain("Jamie");
    expect(renderOrderReceivedMessage("  ")).toContain("there");
  });
});

describe("renderRefillOrderReceivedMessage", () => {
  it("introduces Sophie, says refill (not the first-order welcome copy), and mentions the portal link", () => {
    const text = renderRefillOrderReceivedMessage("Jamie");
    expect(text).toContain("this is Sophie");
    expect(text).toContain("refill");
    expect(text).not.toContain("the doctor is reviewing it");
    expect(text).toContain("https://patient.tryark.com/login");
  });

  it("interpolates the first name, falling back to 'there' when blank", () => {
    expect(renderRefillOrderReceivedMessage("Jamie")).toContain("Jamie");
    expect(renderRefillOrderReceivedMessage("  ")).toContain("there");
  });
});

describe("renderPrescriptionWrittenMessage", () => {
  it("has no question mark and no em dash", () => {
    const text = renderPrescriptionWrittenMessage("Jamie");
    expect(text).not.toContain("?");
    expect(text).not.toMatch(/—|--/);
  });

  it("interpolates the first name, falling back to 'there' when blank", () => {
    expect(renderPrescriptionWrittenMessage("Jamie")).toContain("Jamie");
    expect(renderPrescriptionWrittenMessage("  ")).toContain("there");
  });
});

describe("renderOrderShippedMessage", () => {
  it("includes the tracking number verbatim", () => {
    const text = renderOrderShippedMessage("Jamie", "1Z999AA10123456784");
    expect(text).toContain("1Z999AA10123456784");
  });

  it("interpolates the first name, falling back to 'there' when blank", () => {
    expect(renderOrderShippedMessage("Jamie", "TRACK1")).toContain("Jamie");
    expect(renderOrderShippedMessage("  ", "TRACK1")).toContain("there");
  });
});

describe("renderReviewRequestMessage", () => {
  it("has exactly one trailing question mark, no em dash", () => {
    const text = renderReviewRequestMessage("Jamie");
    expect((text.match(/\?/g) ?? []).length).toBe(1);
    expect(text.trim().endsWith("?")).toBe(true);
    expect(text).not.toMatch(/—|--/);
  });

  it("interpolates the first name, falling back to 'there' when blank", () => {
    expect(renderReviewRequestMessage("Jamie")).toContain("Jamie");
    expect(renderReviewRequestMessage("  ")).toContain("there");
  });
});

describe("renderPaymentFailedFirstOrderMessage", () => {
  it("asks the patient to reply, not to expect a self-service link", () => {
    const text = renderPaymentFailedFirstOrderMessage("Jamie");
    expect(text).toContain("Reply here");
    expect(text).not.toMatch(/—|--/);
  });

  it("interpolates the first name, falling back to 'there' when blank", () => {
    expect(renderPaymentFailedFirstOrderMessage("Jamie")).toContain("Jamie");
    expect(renderPaymentFailedFirstOrderMessage("  ")).toContain("there");
  });
});

describe("renderPaymentFailedRecurringMessage", () => {
  it("asks whether they still want to move forward, exactly one question mark, no em dash", () => {
    const text = renderPaymentFailedRecurringMessage("Jamie");
    expect(text).toMatch(/still interested/i);
    expect(text).toContain("refill");
    expect((text.match(/\?/g) ?? []).length).toBe(1);
    expect(text).not.toMatch(/—|--/);
  });

  it("interpolates the first name, falling back to 'there' when blank", () => {
    expect(renderPaymentFailedRecurringMessage("Jamie")).toContain("Jamie");
    expect(renderPaymentFailedRecurringMessage("  ")).toContain("there");
  });
});
