import { describe, expect, it } from "vitest";
import {
  htmlToPlainText,
  wrapEmailHtml,
  renderOrderReceivedEmail,
  renderRefillOrderReceivedEmail,
  renderPrescriptionWrittenEmail,
  renderOrderShippedEmail,
  renderPaymentFailedFirstOrderEmail,
  renderPaymentFailedRecurringEmail,
  renderAbandonedCartOpenerEmail,
  renderAbandonedCartUrgencyEmail,
  renderAbandonedCartEducationalEmail,
  renderAbandonedCartPlanComparisonEmail,
  renderConversationReplyEmail,
} from "./templates.js";

const UNSUB_URL = "http://localhost:3000/unsubscribe/abc.def";
const CTA_URL = "http://localhost:3000/go/abc123";

describe("htmlToPlainText", () => {
  it("strips tags, collapses horizontal whitespace within a line, and preserves a line break between block-level elements", () => {
    expect(htmlToPlainText("<p>Hello  <strong>there</strong></p>\n<p>Bye</p>")).toBe("Hello there\n\nBye");
  });

  it("strips <style> block content, not just the tags around it — CSS rules aren't visible body text", () => {
    const html = "<head><style>.step { color: #b8935a; border-radius: 50%; }</style></head><body><p>Welcome</p></body>";
    expect(htmlToPlainText(html)).toBe("Welcome");
  });

  it("strips <script> block content", () => {
    expect(htmlToPlainText("<script>console.log('x');</script><p>Hi</p>")).toBe("Hi");
  });

  it("strips HTML comments, including MSO conditional comments, and turns <br> into a real line break", () => {
    expect(htmlToPlainText("<p>Warmly,<!--[if mso]>&nbsp;<![endif]--><br>The Team</p>")).toBe("Warmly,\nThe Team");
  });

  it("decodes common HTML entities instead of leaving them literal", () => {
    expect(htmlToPlainText("<p>Approval &amp; Prescription</p>")).toBe("Approval & Prescription");
    expect(htmlToPlainText("<p>Here&#39;s to your journey</p>")).toBe("Here's to your journey");
  });

  it("never collapses a real paragraph/div boundary into a bare space — the exact bug that let a quoted email's own \"Unsubscribe from future emails\" footer end up glued onto a customer's new reply text with nothing for stripQuotedReply to find", () => {
    // Shape of a real Apple Mail HTML reply: the customer's new text in its
    // own <div>s, then the quote-attribution line, then the quoted original
    // message (including our own automated footer) in a <blockquote>.
    const html =
      "<div>Yes I do want to restart.</div>" +
      "<div>Thanks Liz</div>" +
      "<div>Sent from my iPhone</div>" +
      "<div>On Sep 12, 2026, at 1:07 PM, Sophie at Ark Health &lt;support@tryark.com&gt; wrote:</div>" +
      "<blockquote type=\"cite\"><div>Hello!</div><div><a href=\"...\">Unsubscribe</a> from future emails.</div></blockquote>";
    const text = htmlToPlainText(html);
    // The real assertion that matters: there's a newline immediately before
    // the quote header, which is exactly what stripQuotedReply's
    // /(^|\n)on .{0,300} wrote:/i requires to find the cut point.
    expect(text).toMatch(/\nOn Sep 12, 2026, at 1:07 PM, Sophie at Ark Health <support@tryark.com> wrote:/);
  });
});

describe("wrapEmailHtml", () => {
  it("includes the unsubscribe link in the footer", () => {
    const html = wrapEmailHtml("<p>hi</p>", UNSUB_URL);
    expect(html).toContain(UNSUB_URL);
    expect(html).toContain("<p>hi</p>");
  });
});

describe("fixed trigger-email templates", () => {
  const cases: Array<[string, () => { subject: string; html: string }]> = [
    ["order received", () => renderOrderReceivedEmail("Jamie", UNSUB_URL)],
    ["refill order received", () => renderRefillOrderReceivedEmail("Jamie", UNSUB_URL)],
    ["prescription written", () => renderPrescriptionWrittenEmail("Jamie", UNSUB_URL)],
    ["order shipped", () => renderOrderShippedEmail("Jamie", "1Z999AA10123456784", UNSUB_URL)],
    ["payment failed (first order)", () => renderPaymentFailedFirstOrderEmail("Jamie", UNSUB_URL)],
    ["payment failed (recurring)", () => renderPaymentFailedRecurringEmail("Jamie", UNSUB_URL)],
    ["abandoned cart opener", () => renderAbandonedCartOpenerEmail("Jamie", CTA_URL, UNSUB_URL)],
    ["abandoned cart urgency", () => renderAbandonedCartUrgencyEmail("Jamie", CTA_URL, UNSUB_URL)],
    ["abandoned cart educational", () => renderAbandonedCartEducationalEmail("Jamie", CTA_URL, UNSUB_URL)],
    ["abandoned cart plan comparison", () => renderAbandonedCartPlanComparisonEmail("Jamie", CTA_URL, UNSUB_URL)],
  ];

  for (const [label, render] of cases) {
    it(`${label}: has a non-empty subject, mentions the customer by name, and carries the unsubscribe link`, () => {
      const { subject, html } = render();
      expect(subject.length).toBeGreaterThan(0);
      expect(html).toContain("Jamie");
      expect(html).toContain(UNSUB_URL);
    });
  }

  it("order-shipped includes the tracking number", () => {
    const { html } = renderOrderShippedEmail("Jamie", "1Z999AA10123456784", UNSUB_URL);
    expect(html).toContain("1Z999AA10123456784");
  });

  it("falls back to 'there' for a blank first name", () => {
    const { html } = renderOrderReceivedEmail("   ", UNSUB_URL);
    expect(html).toContain("there");
  });

  it("payment-failed (recurring) asks whether they still want the refill; payment-failed (first order) does not", () => {
    const recurring = renderPaymentFailedRecurringEmail("Jamie", UNSUB_URL);
    expect(recurring.html).toMatch(/still interested/i);
    expect(recurring.html).toContain("refill");

    const firstOrder = renderPaymentFailedFirstOrderEmail("Jamie", UNSUB_URL);
    expect(firstOrder.html).not.toMatch(/still interested/i);
  });

  it("each abandoned-cart drip step's CTA button links to the minted per-lead ctaUrl, not a static link", () => {
    for (const render of [renderAbandonedCartOpenerEmail, renderAbandonedCartUrgencyEmail, renderAbandonedCartEducationalEmail, renderAbandonedCartPlanComparisonEmail]) {
      const { html } = render("Jamie", CTA_URL, UNSUB_URL);
      expect(html).toContain(`href="${CTA_URL}"`);
    }
  });
});

describe("renderConversationReplyEmail", () => {
  it("splits on blank lines into separate paragraphs and carries the unsubscribe link", () => {
    const html = renderConversationReplyEmail("First paragraph.\n\nSecond paragraph.", UNSUB_URL);
    expect(html).toContain("<p>First paragraph.</p>");
    expect(html).toContain("<p>Second paragraph.</p>");
    expect(html).toContain(UNSUB_URL);
  });
});
