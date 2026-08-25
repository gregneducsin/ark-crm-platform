/**
 * Fixed, pre-approved email templates for automated trigger sends — same
 * "fixed text, not AI-drafted" reasoning as follow-up-templates.ts and
 * support/templates.ts: a proactive outbound notice has no inbound message
 * to react to, so there's nothing for the guardrail loop to validate
 * against.
 *
 * Every template — whether a full branded HTML document (order received/
 * shipped, prescription written, the abandoned-cart drip sequence) or the
 * plain wrapEmailHtml-wrapped fallback (renderConversationReplyEmail, for
 * AI-drafted replies) — carries the CAN-SPAM required footer (physical
 * address + one-click unsubscribe link), so there's no per-template
 * special-casing to get wrong.
 *
 * Some trigger events (review request, both lead-checkin variants) have no
 * real design yet and are deliberately NOT sent by email at all — see the
 * "no email leg" comments at their SMS call sites in order-fulfillment
 * .service.ts / lead-checkin.service.ts. Add the render function here and
 * wire it in there once real copy exists; don't ship placeholder copy.
 */

const PHYSICAL_ADDRESS_FALLBACK = "Ark Health";

function physicalAddress(): string {
  return process.env.ARK_PHYSICAL_ADDRESS ?? PHYSICAL_ADDRESS_FALLBACK;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
}

/**
 * Crude but dependency-free HTML→text, used two ways: turning a parsed
 * inbound email's HTML-only body into something the guardrail/AI turn can
 * read (email-inbound.service.ts), and turning an outbound template's
 * rendered HTML into the plain-text record stored as conversation history
 * (send-trigger-email.ts) — that history is what a later inbound turn's
 * toEmailPreviewBody/toSupportEmailPreviewBody feeds back to the model, so
 * it must never contain raw markup.
 */
export function htmlToPlainText(html: string): string {
  return html
    // <style>/<script> block content isn't visible markup — stripping only
    // the tags (as this function used to) leaves the CSS/JS text itself
    // behind as if it were body copy. Comments (including MSO conditional
    // comments the templates use for Outlook) get the same treatment.
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function wrapEmailHtml(bodyHtml: string, unsubscribeUrl: string): string {
  return (
    `<div style="font-family: -apple-system, sans-serif; font-size: 15px; line-height: 1.5; color: #1a1a1a; max-width: 600px;">` +
    `${bodyHtml}` +
    `<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0 12px;" />` +
    `<p style="font-size: 12px; color: #888;">${physicalAddress()}<br/>` +
    `<a href="${unsubscribeUrl}" style="color: #888;">Unsubscribe</a> from future emails.</p>` +
    `</div>`
  );
}

export function renderOrderReceivedEmail(firstName: string, unsubscribeUrl: string): RenderedEmail {
  const name = firstName.trim() || "there";
  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Welcome to Ark Health — Your Journey Starts Now</title>
<!--[if mso]>
<noscript>
<xml>
<o:OfficeDocumentSettings>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml>
</noscript>
<![endif]-->
<style>
  body, table, td { font-family: 'Georgia', 'Times New Roman', serif; }
  body { margin: 0; padding: 0; background-color: #f5f1ea; }
  .email-wrapper { width: 100%; background-color: #f5f1ea; padding: 40px 0; }
  .email-container { max-width: 600px; margin: 0 auto; background-color: #fffdf9; border: 1px solid #e8dfd0; }
  .header { background-color: #2b2420; padding: 36px 40px; text-align: center; }
  .logo-text { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 30px; letter-spacing: 3px; color: #d4af6a; margin: 0; font-weight: 500; }
  .header-sub { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; color: #cbbfa8; text-transform: uppercase; margin-top: 6px; }
  .body-content { padding: 44px 40px 20px 40px; }
  .greeting { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26px; color: #2b2420; margin: 0 0 22px 0; font-weight: 500; }
  .paragraph { font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 26px; color: #4a4038; margin: 0 0 20px 0; }
  .steps-box { background-color: #f5f1ea; border: 1px solid #e8dfd0; border-radius: 4px; padding: 26px 28px; margin: 0 0 26px 0; }
  .step-row { font-family: Arial, sans-serif; font-size: 14px; line-height: 22px; color: #4a4038; margin: 0 0 16px 0; }
  .step-row:last-child { margin-bottom: 0; }
  .step-number { display: inline-block; width: 22px; height: 22px; background-color: #b8935a; color: #fffdf9; border-radius: 50%; text-align: center; line-height: 22px; font-weight: bold; font-size: 12px; margin-right: 8px; }
  .step-title { color: #2b2420; font-weight: bold; }
  .cta-wrapper { text-align: center; margin: 32px 0; }
  .cta-button { display: inline-block; background-color: #b8935a; color: #fffdf9; font-family: Arial, sans-serif; font-size: 15px; font-weight: bold; letter-spacing: 1px; text-decoration: none; padding: 16px 38px; border-radius: 3px; text-transform: uppercase; }
  .divider { border: none; border-top: 1px solid #e8dfd0; margin: 30px 0; }
  .footer { padding: 28px 40px 40px 40px; text-align: center; }
  .footer-text { font-family: Arial, sans-serif; font-size: 12px; line-height: 20px; color: #948a7c; margin: 4px 0; }
  .footer-phone { color: #b8935a; text-decoration: none; font-weight: bold; }
  a { color: #b8935a; }
</style>
</head>
<body>
<div class="email-wrapper">
  <table class="email-container" role="presentation" cellpadding="0" cellspacing="0" width="100%">
    <tr>
      <td class="header">
        <p class="logo-text">ARK HEALTH</p>
        <p class="header-sub">Your Journey to Wellness</p>
      </td>
    </tr>
    <tr>
      <td class="body-content">
        <p class="greeting">Welcome, ${name}.</p>

        <p class="paragraph">Thank you for choosing Ark Health. You've just taken the first step toward a healthier, more confident version of yourself — and we're honored to be part of that journey with you.</p>

        <p class="paragraph">Your visit has been received, and our licensed medical team is already reviewing your information to build a treatment plan around your goals.</p>

        <div class="steps-box">
          <p class="step-row"><span class="step-number">1</span><span class="step-title">Clinical Review</span><br>Our medical team reviews your visit and confirms your personalized treatment plan.</p>
          <p class="step-row"><span class="step-number">2</span><span class="step-title">Approval &amp; Prescription</span><br>Once approved, your prescription is sent directly to our licensed pharmacy partner.</p>
          <p class="step-row"><span class="step-number">3</span><span class="step-title">Shipping</span><br>Your medication is prepared and shipped discreetly straight to your door.</p>
          <p class="step-row"><span class="step-number">4</span><span class="step-title">Ongoing Support</span><br>Your care team stays with you for questions, adjustments, and support along the way.</p>
        </div>

        <p class="paragraph">You can track your visit, message your care team, and manage refills anytime through your patient portal.</p>

        <div class="cta-wrapper">
          <a href="https://patient.tryark.com/login" class="cta-button">Go To Patient Login</a>
        </div>

        <p class="paragraph">If you have any questions along the way, we're just a call or message away at <a href="tel:8557582275" class="footer-phone">(855) 758-2275</a>.</p>

        <p class="paragraph" style="margin-bottom:0;">Here's to your journey — we're glad you're on it.<br><!--[if mso]>&nbsp;<![endif]--><br>Warmly,<br>The Ark Health Team</p>
      </td>
    </tr>
    <tr>
      <td><hr class="divider" style="margin-left:40px; margin-right:40px;"></td>
    </tr>
    <tr>
      <td class="footer">
        <p class="footer-text">Ark Health &middot; 8 The Green, Dover, DE</p>
        <p class="footer-text"><a href="tel:8557582275" class="footer-phone">(855) 758-2275</a></p>
        <p class="footer-text"><a href="${unsubscribeUrl}" class="footer-phone">Unsubscribe</a> from future emails.</p>
      </td>
    </tr>
  </table>
</div>
</body>
</html>`;
  return { subject: "Welcome to Ark Health — Your Journey Starts Now", html };
}

export function renderRefillOrderReceivedEmail(firstName: string, unsubscribeUrl: string): RenderedEmail {
  const name = firstName.trim() || "there";
  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>We've received your Ark Health refill order</title>
<!--[if mso]>
<noscript>
<xml>
<o:OfficeDocumentSettings>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml>
</noscript>
<![endif]-->
<style>
  body, table, td { font-family: 'Georgia', 'Times New Roman', serif; }
  body { margin: 0; padding: 0; background-color: #f5f1ea; }
  .email-wrapper { width: 100%; background-color: #f5f1ea; padding: 40px 0; }
  .email-container { max-width: 600px; margin: 0 auto; background-color: #fffdf9; border: 1px solid #e8dfd0; }
  .header { background-color: #2b2420; padding: 36px 40px; text-align: center; }
  .logo-text { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 30px; letter-spacing: 3px; color: #d4af6a; margin: 0; font-weight: 500; }
  .header-sub { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; color: #cbbfa8; text-transform: uppercase; margin-top: 6px; }
  .body-content { padding: 44px 40px 20px 40px; }
  .greeting { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26px; color: #2b2420; margin: 0 0 22px 0; font-weight: 500; }
  .paragraph { font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 26px; color: #4a4038; margin: 0 0 20px 0; }
  .status-box { background-color: #2b2420; border-radius: 4px; padding: 26px 24px; margin: 0 0 26px 0; text-align: center; }
  .status-label { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; color: #cbbfa8; text-transform: uppercase; margin: 0 0 8px 0; }
  .status-value { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26px; color: #d4af6a; margin: 0; font-weight: 500; }
  .cta-wrapper { text-align: center; margin: 32px 0; }
  .cta-button { display: inline-block; background-color: #b8935a; color: #fffdf9; font-family: Arial, sans-serif; font-size: 15px; font-weight: bold; letter-spacing: 1px; text-decoration: none; padding: 16px 38px; border-radius: 3px; text-transform: uppercase; }
  .divider { border: none; border-top: 1px solid #e8dfd0; margin: 30px 0; }
  .footer { padding: 28px 40px 40px 40px; text-align: center; }
  .footer-text { font-family: Arial, sans-serif; font-size: 12px; line-height: 20px; color: #948a7c; margin: 4px 0; }
  .footer-phone { color: #b8935a; text-decoration: none; font-weight: bold; }
  a { color: #b8935a; }
</style>
</head>
<body>
<div class="email-wrapper">
  <table class="email-container" role="presentation" cellpadding="0" cellspacing="0" width="100%">
    <tr>
      <td class="header">
        <p class="logo-text">ARK HEALTH</p>
        <p class="header-sub">Your Journey to Wellness</p>
      </td>
    </tr>
    <tr>
      <td class="body-content">
        <p class="greeting">Hi ${name},</p>

        <p class="paragraph">We've received your refill order and it's being processed now.</p>

        <div class="status-box">
          <p class="status-label">Refill Status</p>
          <p class="status-value">Processing</p>
        </div>

        <p class="paragraph">We'll let you know as soon as it ships. In the meantime, you can check your order anytime through your patient portal.</p>

        <div class="cta-wrapper">
          <a href="https://patient.tryark.com/login" class="cta-button">View My Patient Portal</a>
        </div>

        <p class="paragraph">Questions? Call or text us at <a href="tel:8557582275" class="footer-phone">(855) 758-2275</a>.</p>

        <p class="paragraph" style="margin-bottom:0;">Warmly,<br>The Ark Health Team</p>
      </td>
    </tr>
    <tr>
      <td><hr class="divider" style="margin-left:40px; margin-right:40px;"></td>
    </tr>
    <tr>
      <td class="footer">
        <p class="footer-text">Ark Health &middot; 8 The Green, Dover, DE</p>
        <p class="footer-text"><a href="tel:8557582275" class="footer-phone">(855) 758-2275</a></p>
        <p class="footer-text"><a href="${unsubscribeUrl}" class="footer-phone">Unsubscribe</a> from future emails.</p>
      </td>
    </tr>
  </table>
</div>
</body>
</html>`;
  return { subject: "We've received your Ark Health refill order", html };
}

export function renderPrescriptionWrittenEmail(firstName: string, unsubscribeUrl: string): RenderedEmail {
  const name = firstName.trim() || "there";
  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your Ark Health prescription has been approved</title>
<!--[if mso]>
<noscript>
<xml>
<o:OfficeDocumentSettings>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml>
</noscript>
<![endif]-->
<style>
  body, table, td { font-family: 'Georgia', 'Times New Roman', serif; }
  body { margin: 0; padding: 0; background-color: #f5f1ea; }
  .email-wrapper { width: 100%; background-color: #f5f1ea; padding: 40px 0; }
  .email-container { max-width: 600px; margin: 0 auto; background-color: #fffdf9; border: 1px solid #e8dfd0; }
  .header { background-color: #2b2420; padding: 36px 40px; text-align: center; }
  .logo-text { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 30px; letter-spacing: 3px; color: #d4af6a; margin: 0; font-weight: 500; }
  .header-sub { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; color: #cbbfa8; text-transform: uppercase; margin-top: 6px; }
  .body-content { padding: 44px 40px 20px 40px; }
  .greeting { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26px; color: #2b2420; margin: 0 0 22px 0; font-weight: 500; }
  .paragraph { font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 26px; color: #4a4038; margin: 0 0 20px 0; }
  .status-box { background-color: #2b2420; border-radius: 4px; padding: 26px 24px; margin: 0 0 26px 0; text-align: center; }
  .status-label { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; color: #cbbfa8; text-transform: uppercase; margin: 0 0 8px 0; }
  .status-value { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26px; color: #d4af6a; margin: 0; font-weight: 500; }
  .steps-box { background-color: #f5f1ea; border: 1px solid #e8dfd0; border-radius: 4px; padding: 26px 28px; margin: 0 0 26px 0; }
  .step-row { font-family: Arial, sans-serif; font-size: 14px; line-height: 22px; color: #4a4038; margin: 0 0 16px 0; }
  .step-row:last-child { margin-bottom: 0; }
  .step-number { display: inline-block; width: 22px; height: 22px; background-color: #b8935a; color: #fffdf9; border-radius: 50%; text-align: center; line-height: 22px; font-weight: bold; font-size: 12px; margin-right: 8px; }
  .step-title { color: #2b2420; font-weight: bold; }
  .cta-wrapper { text-align: center; margin: 32px 0; }
  .cta-button { display: inline-block; background-color: #b8935a; color: #fffdf9; font-family: Arial, sans-serif; font-size: 15px; font-weight: bold; letter-spacing: 1px; text-decoration: none; padding: 16px 38px; border-radius: 3px; text-transform: uppercase; }
  .divider { border: none; border-top: 1px solid #e8dfd0; margin: 30px 0; }
  .footer { padding: 28px 40px 40px 40px; text-align: center; }
  .footer-text { font-family: Arial, sans-serif; font-size: 12px; line-height: 20px; color: #948a7c; margin: 4px 0; }
  .footer-phone { color: #b8935a; text-decoration: none; font-weight: bold; }
  a { color: #b8935a; }
</style>
</head>
<body>
<div class="email-wrapper">
  <table class="email-container" role="presentation" cellpadding="0" cellspacing="0" width="100%">
    <tr>
      <td class="header">
        <p class="logo-text">ARK HEALTH</p>
        <p class="header-sub">Your Journey to Wellness</p>
      </td>
    </tr>
    <tr>
      <td class="body-content">
        <p class="greeting">Dear ${name},</p>

        <p class="paragraph">Great news — your prescription has been approved by our licensed medical team.</p>

        <div class="status-box">
          <p class="status-label">Prescription Status</p>
          <p class="status-value">Approved</p>
        </div>

        <p class="paragraph">Your treatment plan is now being sent to our pharmacy partner to be prepared specifically for you.</p>

        <div class="steps-box">
          <p class="step-row"><span class="step-number">1</span><span class="step-title">Prescription Approved</span><br>Your care team has confirmed your personalized treatment plan. <em>You are here.</em></p>
          <p class="step-row"><span class="step-number">2</span><span class="step-title">Pharmacy Preparation</span><br>Your medication is compounded and prepared by our licensed pharmacy partner.</p>
          <p class="step-row"><span class="step-number">3</span><span class="step-title">Shipping</span><br>Your order ships discreetly straight to your door, with tracking sent by email.</p>
          <p class="step-row"><span class="step-number">4</span><span class="step-title">Ongoing Support</span><br>Your care team stays with you for questions, adjustments, and support along the way.</p>
        </div>

        <div class="cta-wrapper">
          <a href="https://patient.tryark.com/login" class="cta-button">View My Patient Portal</a>
        </div>

        <p class="paragraph">We'll let you know as soon as your order ships. In the meantime, if you have any questions about your treatment plan, we're here to help.</p>

        <p class="paragraph">Questions? Call or text us at <a href="tel:8557582275" class="footer-phone">(855) 758-2275</a>.</p>

        <p class="paragraph" style="margin-bottom:0;">Here's to your journey — we're glad you're on it.<br><!--[if mso]>&nbsp;<![endif]--><br>Warmly,<br>The Ark Health Team</p>
      </td>
    </tr>
    <tr>
      <td><hr class="divider" style="margin-left:40px; margin-right:40px;"></td>
    </tr>
    <tr>
      <td class="footer">
        <p class="footer-text">Ark Health &middot; 8 The Green, Dover, DE</p>
        <p class="footer-text"><a href="tel:8557582275" class="footer-phone">(855) 758-2275</a></p>
        <p class="footer-text"><a href="${unsubscribeUrl}" class="footer-phone">Unsubscribe</a> from future emails.</p>
      </td>
    </tr>
  </table>
</div>
</body>
</html>`;
  return { subject: "Your Ark Health prescription has been approved", html };
}

export function renderOrderShippedEmail(firstName: string, trackingNumber: string, unsubscribeUrl: string): RenderedEmail {
  const name = firstName.trim() || "there";
  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your Ark Health order has shipped</title>
<!--[if mso]>
<noscript>
<xml>
<o:OfficeDocumentSettings>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml>
</noscript>
<![endif]-->
<style>
  body, table, td { font-family: 'Georgia', 'Times New Roman', serif; }
  body { margin: 0; padding: 0; background-color: #f5f1ea; }
  .email-wrapper { width: 100%; background-color: #f5f1ea; padding: 40px 0; }
  .email-container { max-width: 600px; margin: 0 auto; background-color: #fffdf9; border: 1px solid #e8dfd0; }
  .header { background-color: #2b2420; padding: 36px 40px; text-align: center; }
  .logo-text { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 30px; letter-spacing: 3px; color: #d4af6a; margin: 0; font-weight: 500; }
  .header-sub { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; color: #cbbfa8; text-transform: uppercase; margin-top: 6px; }
  .body-content { padding: 44px 40px 20px 40px; }
  .greeting { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26px; color: #2b2420; margin: 0 0 22px 0; font-weight: 500; }
  .paragraph { font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 26px; color: #4a4038; margin: 0 0 20px 0; }
  .status-box { background-color: #2b2420; border-radius: 4px; padding: 26px 24px; margin: 0 0 26px 0; text-align: center; }
  .status-label { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; color: #cbbfa8; text-transform: uppercase; margin: 0 0 8px 0; }
  .status-value { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26px; color: #d4af6a; margin: 0; font-weight: 500; }
  .tracking-box { background-color: #f5f1ea; border: 1px solid #e8dfd0; border-radius: 4px; padding: 20px 24px; margin: 0 0 26px 0; }
  .tracking-row { font-family: Arial, sans-serif; font-size: 14px; color: #4a4038; margin: 0 0 6px 0; }
  .tracking-row:last-child { margin-bottom: 0; }
  .tracking-label { color: #948a7c; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; display: block; margin-bottom: 2px; }
  .tracking-value { color: #2b2420; font-weight: bold; }
  .cta-wrapper { text-align: center; margin: 32px 0; }
  .cta-button { display: inline-block; background-color: #b8935a; color: #fffdf9; font-family: Arial, sans-serif; font-size: 15px; font-weight: bold; letter-spacing: 1px; text-decoration: none; padding: 16px 38px; border-radius: 3px; text-transform: uppercase; }
  .divider { border: none; border-top: 1px solid #e8dfd0; margin: 30px 0; }
  .footer { padding: 28px 40px 40px 40px; text-align: center; }
  .footer-text { font-family: Arial, sans-serif; font-size: 12px; line-height: 20px; color: #948a7c; margin: 4px 0; }
  .footer-phone { color: #b8935a; text-decoration: none; font-weight: bold; }
  a { color: #b8935a; }
</style>
</head>
<body>
<div class="email-wrapper">
  <table class="email-container" role="presentation" cellpadding="0" cellspacing="0" width="100%">
    <tr>
      <td class="header">
        <p class="logo-text">ARK HEALTH</p>
        <p class="header-sub">Your Journey to Wellness</p>
      </td>
    </tr>
    <tr>
      <td class="body-content">
        <p class="greeting">Dear ${name},</p>

        <p class="paragraph">Good news — your order is on its way.</p>

        <div class="status-box">
          <p class="status-label">Order Status</p>
          <p class="status-value">Shipped</p>
        </div>

        <p class="paragraph">Your medication was prepared by our licensed pharmacy partner and is now headed straight to your door, packaged discreetly for your privacy.</p>

        <div class="tracking-box">
          <p class="tracking-row">
            <span class="tracking-label">Tracking Number</span>
            <span class="tracking-value">${trackingNumber}</span>
          </p>
        </div>

        <div class="cta-wrapper">
          <a href="https://patient.tryark.com/login" class="cta-button">Track My Order</a>
        </div>

        <p class="paragraph">When your package arrives, be sure to follow the dosing instructions provided by your care team. If you have any questions about getting started or what to expect, we're here to help.</p>

        <p class="paragraph">Questions? Call or text us at <a href="tel:8557582275" class="footer-phone">(855) 758-2275</a>.</p>

        <p class="paragraph" style="margin-bottom:0;">Here's to your journey — we're glad you're on it.<br><!--[if mso]>&nbsp;<![endif]--><br>Warmly,<br>The Ark Health Team</p>
      </td>
    </tr>
    <tr>
      <td><hr class="divider" style="margin-left:40px; margin-right:40px;"></td>
    </tr>
    <tr>
      <td class="footer">
        <p class="footer-text">Ark Health &middot; 8 The Green, Dover, DE</p>
        <p class="footer-text"><a href="tel:8557582275" class="footer-phone">(855) 758-2275</a></p>
        <p class="footer-text"><a href="${unsubscribeUrl}" class="footer-phone">Unsubscribe</a> from future emails.</p>
      </td>
    </tr>
  </table>
</div>
</body>
</html>`;
  return { subject: "Your Ark Health order has shipped", html };
}

/**
 * Fired from handlePaymentFailed when a bask_payment_failed webhook
 * arrives — correcting course after the order-received email already went
 * out the moment the order landed, before payment was actually confirmed.
 * No CTA button/link here (unlike the other status emails) — there's no
 * confirmed self-service payment-retry page, so this is deliberately
 * staff-assisted: ask the patient to reply or call, same as the SMS
 * variant, rather than pointing at a URL that might not exist.
 */
export function renderPaymentFailedFirstOrderEmail(firstName: string, unsubscribeUrl: string): RenderedEmail {
  const name = firstName.trim() || "there";
  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>We couldn't process the payment for your Ark Health order</title>
<!--[if mso]>
<noscript>
<xml>
<o:OfficeDocumentSettings>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml>
</noscript>
<![endif]-->
<style>
  body, table, td { font-family: 'Georgia', 'Times New Roman', serif; }
  body { margin: 0; padding: 0; background-color: #f5f1ea; }
  .email-wrapper { width: 100%; background-color: #f5f1ea; padding: 40px 0; }
  .email-container { max-width: 600px; margin: 0 auto; background-color: #fffdf9; border: 1px solid #e8dfd0; }
  .header { background-color: #2b2420; padding: 36px 40px; text-align: center; }
  .logo-text { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 30px; letter-spacing: 3px; color: #d4af6a; margin: 0; font-weight: 500; }
  .header-sub { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; color: #cbbfa8; text-transform: uppercase; margin-top: 6px; }
  .body-content { padding: 44px 40px 20px 40px; }
  .greeting { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26px; color: #2b2420; margin: 0 0 22px 0; font-weight: 500; }
  .paragraph { font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 26px; color: #4a4038; margin: 0 0 20px 0; }
  .status-box { background-color: #2b2420; border-radius: 4px; padding: 26px 24px; margin: 0 0 26px 0; text-align: center; }
  .status-label { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; color: #cbbfa8; text-transform: uppercase; margin: 0 0 8px 0; }
  .status-value { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26px; color: #d4af6a; margin: 0; font-weight: 500; }
  .divider { border: none; border-top: 1px solid #e8dfd0; margin: 30px 0; }
  .footer { padding: 28px 40px 40px 40px; text-align: center; }
  .footer-text { font-family: Arial, sans-serif; font-size: 12px; line-height: 20px; color: #948a7c; margin: 4px 0; }
  .footer-phone { color: #b8935a; text-decoration: none; font-weight: bold; }
  a { color: #b8935a; }
</style>
</head>
<body>
<div class="email-wrapper">
  <table class="email-container" role="presentation" cellpadding="0" cellspacing="0" width="100%">
    <tr>
      <td class="header">
        <p class="logo-text">ARK HEALTH</p>
        <p class="header-sub">Your Journey to Wellness</p>
      </td>
    </tr>
    <tr>
      <td class="body-content">
        <p class="greeting">Dear ${name},</p>

        <p class="paragraph">We weren't able to process the payment for your order, so we can't move forward with it yet.</p>

        <div class="status-box">
          <p class="status-label">Order Status</p>
          <p class="status-value">Payment Needed</p>
        </div>

        <p class="paragraph">Just reply to this email, or call or text us at <a href="tel:8557582275" class="footer-phone">(855) 758-2275</a>, and we'll get your payment sorted out.</p>

        <p class="paragraph" style="margin-bottom:0;">We're here to help.<br><!--[if mso]>&nbsp;<![endif]--><br>Warmly,<br>The Ark Health Team</p>
      </td>
    </tr>
    <tr>
      <td><hr class="divider" style="margin-left:40px; margin-right:40px;"></td>
    </tr>
    <tr>
      <td class="footer">
        <p class="footer-text">Ark Health &middot; 8 The Green, Dover, DE</p>
        <p class="footer-text"><a href="tel:8557582275" class="footer-phone">(855) 758-2275</a></p>
        <p class="footer-text"><a href="${unsubscribeUrl}" class="footer-phone">Unsubscribe</a> from future emails.</p>
      </td>
    </tr>
  </table>
</div>
</body>
</html>`;
  return { subject: "We couldn't process the payment for your Ark Health order", html };
}

export function renderPaymentFailedRecurringEmail(firstName: string, unsubscribeUrl: string): RenderedEmail {
  const name = firstName.trim() || "there";
  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>We couldn't process the payment for your Ark Health refill</title>
<!--[if mso]>
<noscript>
<xml>
<o:OfficeDocumentSettings>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml>
</noscript>
<![endif]-->
<style>
  body, table, td { font-family: 'Georgia', 'Times New Roman', serif; }
  body { margin: 0; padding: 0; background-color: #f5f1ea; }
  .email-wrapper { width: 100%; background-color: #f5f1ea; padding: 40px 0; }
  .email-container { max-width: 600px; margin: 0 auto; background-color: #fffdf9; border: 1px solid #e8dfd0; }
  .header { background-color: #2b2420; padding: 36px 40px; text-align: center; }
  .logo-text { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 30px; letter-spacing: 3px; color: #d4af6a; margin: 0; font-weight: 500; }
  .header-sub { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; color: #cbbfa8; text-transform: uppercase; margin-top: 6px; }
  .body-content { padding: 44px 40px 20px 40px; }
  .greeting { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26px; color: #2b2420; margin: 0 0 22px 0; font-weight: 500; }
  .paragraph { font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 26px; color: #4a4038; margin: 0 0 20px 0; }
  .status-box { background-color: #2b2420; border-radius: 4px; padding: 26px 24px; margin: 0 0 26px 0; text-align: center; }
  .status-label { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; color: #cbbfa8; text-transform: uppercase; margin: 0 0 8px 0; }
  .status-value { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26px; color: #d4af6a; margin: 0; font-weight: 500; }
  .divider { border: none; border-top: 1px solid #e8dfd0; margin: 30px 0; }
  .footer { padding: 28px 40px 40px 40px; text-align: center; }
  .footer-text { font-family: Arial, sans-serif; font-size: 12px; line-height: 20px; color: #948a7c; margin: 4px 0; }
  .footer-phone { color: #b8935a; text-decoration: none; font-weight: bold; }
  a { color: #b8935a; }
</style>
</head>
<body>
<div class="email-wrapper">
  <table class="email-container" role="presentation" cellpadding="0" cellspacing="0" width="100%">
    <tr>
      <td class="header">
        <p class="logo-text">ARK HEALTH</p>
        <p class="header-sub">Your Journey to Wellness</p>
      </td>
    </tr>
    <tr>
      <td class="body-content">
        <p class="greeting">Dear ${name},</p>

        <p class="paragraph">We weren't able to process the payment for your refill.</p>

        <div class="status-box">
          <p class="status-label">Refill Status</p>
          <p class="status-value">Payment Needed</p>
        </div>

        <p class="paragraph">Are you still interested in moving forward with it? Just reply to this email, or call or text us at <a href="tel:8557582275" class="footer-phone">(855) 758-2275</a>, and we'll get it sorted out.</p>

        <p class="paragraph" style="margin-bottom:0;">We're here to help.<br><!--[if mso]>&nbsp;<![endif]--><br>Warmly,<br>The Ark Health Team</p>
      </td>
    </tr>
    <tr>
      <td><hr class="divider" style="margin-left:40px; margin-right:40px;"></td>
    </tr>
    <tr>
      <td class="footer">
        <p class="footer-text">Ark Health &middot; 8 The Green, Dover, DE</p>
        <p class="footer-text"><a href="tel:8557582275" class="footer-phone">(855) 758-2275</a></p>
        <p class="footer-text"><a href="${unsubscribeUrl}" class="footer-phone">Unsubscribe</a> from future emails.</p>
      </td>
    </tr>
  </table>
</div>
</body>
</html>`;
  return { subject: "We couldn't process the payment for your Ark Health refill", html };
}

/**
 * `ctaUrl` must be a freshly-minted per-lead intake link (createIntakeLink
 * with promo "first_month_20"), not the bare Bask questionnaire URL —
 * clicking it is what arms the 2-hour follow-up job (see
 * intake-links.service.ts's handleIntakeLinkClick), same as the link Alexis's
 * SMS conversation mints on action=send_form. A static, unminted link here
 * would silently skip that automation for every email-driven signup.
 */
export function renderAbandonedCartOpenerEmail(firstName: string, ctaUrl: string, unsubscribeUrl: string): RenderedEmail {
  const name = firstName.trim() || "there";
  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your Ark Health visit is waiting — don't lose your spot</title>
<!--[if mso]>
<noscript>
<xml>
<o:OfficeDocumentSettings>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml>
</noscript>
<![endif]-->
<style>
  body, table, td { font-family: 'Georgia', 'Times New Roman', serif; }
  body { margin: 0; padding: 0; background-color: #f5f1ea; }
  .email-wrapper { width: 100%; background-color: #f5f1ea; padding: 40px 0; }
  .email-container { max-width: 600px; margin: 0 auto; background-color: #fffdf9; border: 1px solid #e8dfd0; }
  .header { background-color: #2b2420; padding: 36px 40px; text-align: center; }
  .logo-text { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 30px; letter-spacing: 3px; color: #d4af6a; margin: 0; font-weight: 500; }
  .header-sub { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; color: #cbbfa8; text-transform: uppercase; margin-top: 6px; }
  .body-content { padding: 44px 40px 20px 40px; }
  .greeting { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26px; color: #2b2420; margin: 0 0 22px 0; font-weight: 500; }
  .paragraph { font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 26px; color: #4a4038; margin: 0 0 20px 0; }
  .price-box { background-color: #f5f1ea; border: 1px solid #e8dfd0; border-radius: 4px; padding: 20px 24px; margin: 0 0 24px 0; }
  .price-row { font-family: Arial, sans-serif; font-size: 15px; color: #2b2420; margin: 0 0 8px 0; }
  .price-row:last-child { margin-bottom: 0; }
  .price-value { color: #b8935a; font-weight: bold; }
  .cta-wrapper { text-align: center; margin: 32px 0; }
  .cta-button { display: inline-block; background-color: #b8935a; color: #fffdf9; font-family: Arial, sans-serif; font-size: 15px; font-weight: bold; letter-spacing: 1px; text-decoration: none; padding: 16px 38px; border-radius: 3px; text-transform: uppercase; }
  .divider { border: none; border-top: 1px solid #e8dfd0; margin: 30px 0; }
  .footer { padding: 28px 40px 40px 40px; text-align: center; }
  .footer-text { font-family: Arial, sans-serif; font-size: 12px; line-height: 20px; color: #948a7c; margin: 4px 0; }
  .footer-phone { color: #b8935a; text-decoration: none; font-weight: bold; }
  a { color: #b8935a; }
</style>
</head>
<body>
<div class="email-wrapper">
  <table class="email-container" role="presentation" cellpadding="0" cellspacing="0" width="100%">
    <tr>
      <td class="header">
        <p class="logo-text">ARK HEALTH</p>
        <p class="header-sub">Your Journey to Wellness</p>
      </td>
    </tr>
    <tr>
      <td class="body-content">
        <p class="greeting">Dear ${name},</p>

        <p class="paragraph">Your Ark Health visit is still open — but it won't stay saved forever.</p>

        <p class="paragraph">You started the process to access physician-guided treatment with real support from our licensed medical team. Don't let a few unanswered questions stand between you and your goals.</p>

        <div class="price-box">
          <p class="price-row">Compounded Semaglutide — <span class="price-value">$175/mo</span></p>
          <p class="price-row">Compounded Tirzepatide — <span class="price-value">$225/mo</span></p>
        </div>

        <p class="paragraph"><strong>Finish now and get $20 off your first month</strong> — our way of helping you take that next step.</p>

        <div class="cta-wrapper">
          <a href="${ctaUrl}" class="cta-button">Finish My Visit Now</a>
        </div>

        <p class="paragraph">It takes just a few minutes, and our clinical team is ready to review your visit as soon as it's submitted.</p>

        <p class="paragraph">Questions? Call or text us at <a href="tel:8557582275" class="footer-phone">(855) 758-2275</a> — we're here to help you finish strong.</p>

        <p class="paragraph" style="margin-bottom:0;">The Ark Health Team</p>
      </td>
    </tr>
    <tr>
      <td><hr class="divider" style="margin-left:40px; margin-right:40px;"></td>
    </tr>
    <tr>
      <td class="footer">
        <p class="footer-text">Ark Health &middot; 8 The Green, Dover, DE</p>
        <p class="footer-text"><a href="tel:8557582275" class="footer-phone">(855) 758-2275</a></p>
        <p class="footer-text"><a href="${unsubscribeUrl}" class="footer-phone">Unsubscribe</a> from future emails.</p>
      </td>
    </tr>
  </table>
</div>
</body>
</html>`;
  return { subject: "Your Ark Health visit is waiting — don't lose your spot", html };
}

/** Abandoned-cart drip step 2 ("urgency") — fires 24 hours after abandonment. Same ctaUrl-minting requirement as renderAbandonedCartOpenerEmail. */
export function renderAbandonedCartUrgencyEmail(firstName: string, ctaUrl: string, unsubscribeUrl: string): RenderedEmail {
  const name = firstName.trim() || "there";
  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your $20 off expires soon — finish your Ark Health visit</title>
<!--[if mso]>
<noscript>
<xml>
<o:OfficeDocumentSettings>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml>
</noscript>
<![endif]-->
<style>
  body, table, td { font-family: 'Georgia', 'Times New Roman', serif; }
  body { margin: 0; padding: 0; background-color: #f5f1ea; }
  .email-wrapper { width: 100%; background-color: #f5f1ea; padding: 40px 0; }
  .email-container { max-width: 600px; margin: 0 auto; background-color: #fffdf9; border: 1px solid #e8dfd0; }
  .header { background-color: #2b2420; padding: 36px 40px; text-align: center; }
  .logo-text { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 30px; letter-spacing: 3px; color: #d4af6a; margin: 0; font-weight: 500; }
  .header-sub { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; color: #cbbfa8; text-transform: uppercase; margin-top: 6px; }
  .body-content { padding: 44px 40px 20px 40px; }
  .greeting { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26px; color: #2b2420; margin: 0 0 22px 0; font-weight: 500; }
  .paragraph { font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 26px; color: #4a4038; margin: 0 0 20px 0; }
  .expiry-box { background-color: #2b2420; border-radius: 4px; padding: 22px 24px; margin: 0 0 24px 0; text-align: center; }
  .expiry-label { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; color: #cbbfa8; text-transform: uppercase; margin: 0 0 8px 0; }
  .expiry-value { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 24px; color: #d4af6a; margin: 0; font-weight: 500; }
  .price-box { background-color: #f5f1ea; border: 1px solid #e8dfd0; border-radius: 4px; padding: 20px 24px; margin: 0 0 24px 0; }
  .price-row { font-family: Arial, sans-serif; font-size: 15px; color: #2b2420; margin: 0 0 8px 0; }
  .price-row:last-child { margin-bottom: 0; }
  .price-value { color: #b8935a; font-weight: bold; }
  .cta-wrapper { text-align: center; margin: 32px 0; }
  .cta-button { display: inline-block; background-color: #b8935a; color: #fffdf9; font-family: Arial, sans-serif; font-size: 15px; font-weight: bold; letter-spacing: 1px; text-decoration: none; padding: 16px 38px; border-radius: 3px; text-transform: uppercase; }
  .divider { border: none; border-top: 1px solid #e8dfd0; margin: 30px 0; }
  .footer { padding: 28px 40px 40px 40px; text-align: center; }
  .footer-text { font-family: Arial, sans-serif; font-size: 12px; line-height: 20px; color: #948a7c; margin: 4px 0; }
  .footer-phone { color: #b8935a; text-decoration: none; font-weight: bold; }
  a { color: #b8935a; }
</style>
</head>
<body>
<div class="email-wrapper">
  <table class="email-container" role="presentation" cellpadding="0" cellspacing="0" width="100%">
    <tr>
      <td class="header">
        <p class="logo-text">ARK HEALTH</p>
        <p class="header-sub">Your Journey to Wellness</p>
      </td>
    </tr>
    <tr>
      <td class="body-content">
        <p class="greeting">Dear ${name},</p>

        <p class="paragraph">Quick reminder — your $20 off first month offer is about to expire, and your Ark Health visit is still sitting unfinished.</p>

        <div class="expiry-box">
          <p class="expiry-label">Offer Expires</p>
          <p class="expiry-value">Tonight at Midnight</p>
        </div>

        <p class="paragraph">Once it's gone, it's gone — but you can still lock in your discount and get started on physician-guided treatment in just a few minutes.</p>

        <div class="price-box">
          <p class="price-row">Compounded Semaglutide — <span class="price-value">$175/mo</span></p>
          <p class="price-row">Compounded Tirzepatide — <span class="price-value">$225/mo</span></p>
        </div>

        <div class="cta-wrapper">
          <a href="${ctaUrl}" class="cta-button">Claim My $20 Off</a>
        </div>

        <p class="paragraph">It only takes a few minutes to complete, and our clinical team will review your visit as soon as it's submitted.</p>

        <p class="paragraph">Questions? Call or text us at <a href="tel:8557582275" class="footer-phone">(855) 758-2275</a> — we're happy to help you finish strong.</p>

        <p class="paragraph" style="margin-bottom:0;">The Ark Health Team</p>
      </td>
    </tr>
    <tr>
      <td><hr class="divider" style="margin-left:40px; margin-right:40px;"></td>
    </tr>
    <tr>
      <td class="footer">
        <p class="footer-text">Ark Health &middot; 8 The Green, Dover, DE</p>
        <p class="footer-text"><a href="tel:8557582275" class="footer-phone">(855) 758-2275</a></p>
        <p class="footer-text"><a href="${unsubscribeUrl}" class="footer-phone">Unsubscribe</a> from future emails.</p>
      </td>
    </tr>
  </table>
</div>
</body>
</html>`;
  return { subject: "Your $20 off expires soon — finish your Ark Health visit", html };
}

/** Abandoned-cart drip step 3 ("educational") — fires 7 days after abandonment. Same ctaUrl-minting requirement as renderAbandonedCartOpenerEmail. */
export function renderAbandonedCartEducationalEmail(firstName: string, ctaUrl: string, unsubscribeUrl: string): RenderedEmail {
  const name = firstName.trim() || "there";
  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>If you've tried everything, this is different</title>
<!--[if mso]>
<noscript>
<xml>
<o:OfficeDocumentSettings>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml>
</noscript>
<![endif]-->
<style>
  body, table, td { font-family: 'Georgia', 'Times New Roman', serif; }
  body { margin: 0; padding: 0; background-color: #f5f1ea; }
  .email-wrapper { width: 100%; background-color: #f5f1ea; padding: 40px 0; }
  .email-container { max-width: 600px; margin: 0 auto; background-color: #fffdf9; border: 1px solid #e8dfd0; }
  .header { background-color: #2b2420; padding: 36px 40px; text-align: center; }
  .logo-text { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 30px; letter-spacing: 3px; color: #d4af6a; margin: 0; font-weight: 500; }
  .header-sub { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; color: #cbbfa8; text-transform: uppercase; margin-top: 6px; }
  .body-content { padding: 44px 40px 20px 40px; }
  .greeting { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26px; color: #2b2420; margin: 0 0 22px 0; font-weight: 500; }
  .paragraph { font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 26px; color: #4a4038; margin: 0 0 20px 0; }
  .quote-box { background-color: #f5f1ea; border-left: 3px solid #b8935a; padding: 18px 22px; margin: 0 0 24px 0; }
  .quote-text { font-family: 'Cormorant Garamond', Georgia, serif; font-style: italic; font-size: 17px; line-height: 25px; color: #2b2420; margin: 0; }
  .price-box { background-color: #f5f1ea; border: 1px solid #e8dfd0; border-radius: 4px; padding: 20px 24px; margin: 0 0 24px 0; }
  .price-row { font-family: Arial, sans-serif; font-size: 15px; color: #2b2420; margin: 0 0 8px 0; }
  .price-row:last-child { margin-bottom: 0; }
  .price-value { color: #b8935a; font-weight: bold; }
  .cta-wrapper { text-align: center; margin: 32px 0; }
  .cta-button { display: inline-block; background-color: #b8935a; color: #fffdf9; font-family: Arial, sans-serif; font-size: 15px; font-weight: bold; letter-spacing: 1px; text-decoration: none; padding: 16px 38px; border-radius: 3px; text-transform: uppercase; }
  .divider { border: none; border-top: 1px solid #e8dfd0; margin: 30px 0; }
  .footer { padding: 28px 40px 40px 40px; text-align: center; }
  .footer-text { font-family: Arial, sans-serif; font-size: 12px; line-height: 20px; color: #948a7c; margin: 4px 0; }
  .footer-phone { color: #b8935a; text-decoration: none; font-weight: bold; }
  a { color: #b8935a; }
</style>
</head>
<body>
<div class="email-wrapper">
  <table class="email-container" role="presentation" cellpadding="0" cellspacing="0" width="100%">
    <tr>
      <td class="header">
        <p class="logo-text">ARK HEALTH</p>
        <p class="header-sub">Your Journey to Wellness</p>
      </td>
    </tr>
    <tr>
      <td class="body-content">
        <p class="greeting">Dear ${name},</p>

        <p class="paragraph">You've probably heard it before: "just eat less, move more." If it were that simple, you wouldn't still be looking for answers.</p>

        <p class="paragraph">Willpower was never the problem. For a lot of people, appetite and metabolism are working against them — no amount of discipline changes that on its own. Diets that ignore this tend to work for a while, then stop. That's not a personal failure. It's biology.</p>

        <div class="quote-box">
          <p class="quote-text">"I'd lose 10 pounds and gain back 15. I stopped trusting that anything would actually work for me."</p>
        </div>

        <p class="paragraph">GLP-1 treatment approaches things differently. Instead of relying on willpower alone, it works with your body's own hormones to help regulate appetite — so the changes you make to your eating actually stick, instead of feeling like a constant fight.</p>

        <p class="paragraph">You don't have to have it all figured out before you start. You just have to be ready to try something that works differently than what you've tried before.</p>

        <div class="price-box">
          <p class="price-row">Compounded Semaglutide — <span class="price-value">$175/mo</span></p>
          <p class="price-row">Compounded Tirzepatide — <span class="price-value">$225/mo</span></p>
        </div>

        <div class="cta-wrapper">
          <a href="${ctaUrl}" class="cta-button">See If I Qualify</a>
        </div>

        <p class="paragraph">A licensed provider reviews your health assessment before anything is prescribed, so you'll know exactly what to expect. No judgment, no lectures — just a plan built around what actually works.</p>

        <p class="paragraph">Questions? Call or text us at <a href="tel:8557582275" class="footer-phone">(855) 758-2275</a> — our team is here to help.</p>

        <p class="paragraph" style="margin-bottom:0;">The Ark Health Team</p>
      </td>
    </tr>
    <tr>
      <td><hr class="divider" style="margin-left:40px; margin-right:40px;"></td>
    </tr>
    <tr>
      <td class="footer">
        <p class="footer-text">Ark Health &middot; 8 The Green, Dover, DE</p>
        <p class="footer-text"><a href="tel:8557582275" class="footer-phone">(855) 758-2275</a></p>
        <p class="footer-text"><a href="${unsubscribeUrl}" class="footer-phone">Unsubscribe</a> from future emails.</p>
      </td>
    </tr>
  </table>
</div>
</body>
</html>`;
  return { subject: "If you've tried everything, this is different", html };
}

/** Abandoned-cart drip step 4 ("plan_comparison", final step) — fires 10 days after abandonment. Same ctaUrl-minting requirement as renderAbandonedCartOpenerEmail. */
export function renderAbandonedCartPlanComparisonEmail(firstName: string, ctaUrl: string, unsubscribeUrl: string): RenderedEmail {
  const name = firstName.trim() || "there";
  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Which Ark Health plan is right for you?</title>
<!--[if mso]>
<noscript>
<xml>
<o:OfficeDocumentSettings>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml>
</noscript>
<![endif]-->
<style>
  body, table, td { font-family: 'Georgia', 'Times New Roman', serif; }
  body { margin: 0; padding: 0; background-color: #f5f1ea; }
  .email-wrapper { width: 100%; background-color: #f5f1ea; padding: 40px 0; }
  .email-container { max-width: 600px; margin: 0 auto; background-color: #fffdf9; border: 1px solid #e8dfd0; }
  .header { background-color: #2b2420; padding: 36px 40px; text-align: center; }
  .logo-text { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 30px; letter-spacing: 3px; color: #d4af6a; margin: 0; font-weight: 500; }
  .header-sub { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; color: #cbbfa8; text-transform: uppercase; margin-top: 6px; }
  .body-content { padding: 44px 40px 20px 40px; }
  .greeting { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26px; color: #2b2420; margin: 0 0 22px 0; font-weight: 500; }
  .paragraph { font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 26px; color: #4a4038; margin: 0 0 20px 0; }
  .section-heading { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 20px; color: #2b2420; margin: 30px 0 14px 0; font-weight: 500; }
  .plan-card { background-color: #f5f1ea; border: 1px solid #e8dfd0; border-radius: 4px; padding: 20px 24px; margin: 0 0 16px 0; }
  .plan-name { font-family: Arial, sans-serif; font-size: 16px; color: #2b2420; font-weight: bold; margin: 0 0 6px 0; }
  .plan-price { font-family: Arial, sans-serif; font-size: 15px; color: #b8935a; font-weight: bold; margin: 0 0 8px 0; }
  .plan-desc { font-family: Arial, sans-serif; font-size: 14px; line-height: 22px; color: #4a4038; margin: 0; }
  .cta-wrapper { text-align: center; margin: 32px 0; }
  .cta-button { display: inline-block; background-color: #b8935a; color: #fffdf9; font-family: Arial, sans-serif; font-size: 15px; font-weight: bold; letter-spacing: 1px; text-decoration: none; padding: 16px 38px; border-radius: 3px; text-transform: uppercase; }
  .divider { border: none; border-top: 1px solid #e8dfd0; margin: 30px 0; }
  .footer { padding: 28px 40px 40px 40px; text-align: center; }
  .footer-text { font-family: Arial, sans-serif; font-size: 12px; line-height: 20px; color: #948a7c; margin: 4px 0; }
  .footer-phone { color: #b8935a; text-decoration: none; font-weight: bold; }
  a { color: #b8935a; }
</style>
</head>
<body>
  <div class="email-wrapper">
    <table class="email-container" role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td class="header">
          <p class="logo-text">ARK HEALTH</p>
          <p class="header-sub">Your Journey to Wellness</p>
        </td>
      </tr>
      <tr>
        <td class="body-content">
          <p class="greeting">Dear ${name},</p>

          <p class="paragraph">If you're still deciding which Ark Health plan fits your goals, here's a closer look at
            what we offer — so you can choose with confidence.</p>

          <p class="paragraph">All of our treatment plans connect you with a licensed provider online, who reviews your
            health history and determines whether a prescription is appropriate. If approved, your medication ships
            directly from a state-licensed pharmacy — no office visits required.</p>

          <p class="section-heading">Our GLP-1 Plans</p>

          <div class="plan-card">
            <p class="plan-name">Compounded Semaglutide</p>
            <p class="plan-price">$175/mo</p>
            <p class="plan-desc">The same active ingredient found in Ozempic&reg; and Wegovy&reg;. A weekly injection
              that helps regulate appetite and support steady, sustainable weight loss alongside nutrition and lifestyle
              changes.</p>
          </div>

          <div class="plan-card">
            <p class="plan-name">Compounded Tirzepatide</p>
            <p class="plan-price">$225/mo</p>
            <p class="plan-desc">The same active ingredient found in Mounjaro&reg; and Zepbound&reg;. A dual-action
              weekly injection that many members choose for its potential to support greater weight loss results.</p>
          </div>

          <p class="paragraph">Every plan includes dose adjustments as needed, ongoing access to your care team, and
            ships discreetly right to your door. Compounded medications are not FDA-approved and have not been evaluated
            for safety or effectiveness — your provider will help you determine what's appropriate for you.</p>

          <div class="cta-wrapper">
            <a href="${ctaUrl}" class="cta-button">See If I Qualify</a>
          </div>

          <p class="paragraph">Not sure which plan is right for you? Our team is happy to walk you through it — call or
            text us at <a href="tel:8557582275" class="footer-phone">(855) 758-2275</a>.</p>

          <p class="paragraph" style="margin-bottom:0;">The Ark Health Team</p>
        </td>
      </tr>
      <tr>
        <td>
          <hr class="divider" style="margin-left:40px; margin-right:40px;">
        </td>
      </tr>
      <tr>
        <td class="footer">
          <p class="footer-text">Ark Health &middot; 8 The Green, Dover, DE</p>
          <p class="footer-text"><a href="tel:8557582275" class="footer-phone">(855) 758-2275</a></p>
          <p class="footer-text"><a href="${unsubscribeUrl}" class="footer-phone">Unsubscribe</a> from future emails.</p>
        </td>
      </tr>
    </table>
  </div>
</body>
</html>`;
  return { subject: "Which Ark Health plan is right for you?", html };
}

/** Plain-reply wrapper for AI-drafted turn replies (Alexis/Sophie email dispatch) — same wrapper, no fixed copy since the text itself is the guardrail-validated draft. */
export function renderConversationReplyEmail(bodyText: string, unsubscribeUrl: string): string {
  const paragraphs = bodyText
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("");
  return wrapEmailHtml(paragraphs, unsubscribeUrl);
}
