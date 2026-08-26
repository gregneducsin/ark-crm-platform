import { randomUUID } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { createGmailClient, encodeMessage } from "../services/gmail.service.js";
import { htmlToPlainText } from "./email/templates.js";
import { notifySlack } from "./slack.js";

/**
 * Outbound email provider abstraction — same shape as sms-provider.ts's
 * SmsProvider, so plugging in a different provider later (Resend, Postmark,
 * SES) is a one-file change here, not a rewrite of the callers.
 */

export interface EmailSendResult {
  /** RFC 5322 Message-ID header of the sent message — used for reply threading (inReplyTo/references) and as the send record's idempotency handle, same role providerMessageId plays for SMS. */
  readonly messageId: string;
}

export interface EmailSendOptions {
  /** Display name for the From header, e.g. "Alexis at Ark Health". Falls back to the provider's configured default identity when omitted. */
  readonly fromName?: string;
  readonly replyTo?: string;
  /** RFC 5322 Message-ID of the message being replied to — sets the In-Reply-To header so mail clients thread the conversation. */
  readonly inReplyTo?: string;
  /** RFC 5322 References header (the full thread chain) — set alongside inReplyTo for correct threading in every mail client, not just ones that thread off In-Reply-To alone. */
  readonly references?: string;
  /**
   * This customer's one-click unsubscribe URL (same value already embedded
   * as a link in the HTML body). When set, both providers also emit a
   * List-Unsubscribe header pointing at it plus List-Unsubscribe-Post,
   * which is what actually gets a mailbox provider to trust automated
   * mail: it's the difference between "give the recipient an easy,
   * one-click opt-out" (a strong positive signal to Gmail/spam filters,
   * per Google's bulk-sender guidelines) and making them dig through the
   * body or hit "report spam" instead — which is exactly the pattern that
   * tanks a new sending identity's reputation.
   */
  readonly unsubscribeUrl?: string;
  /**
   * Sends from this exact address instead of the provider's configured
   * default — used to reply from whichever real mailbox (e.g. help@ vs
   * support@) a customer originally wrote to, once the authenticated
   * mailbox's Gmail "Send mail as" settings include it as a verified
   * alias (Gmail silently falls back to the authenticated account's own
   * address otherwise, rather than erroring — see EMAIL_INBOUND_EXTRA_MAILBOXES
   * in .env.example).
   */
  readonly fromEmailOverride?: string;
}

export interface EmailProvider {
  sendEmail(to: string, subject: string, html: string, opts?: EmailSendOptions): Promise<EmailSendResult>;
}

export class EmailProviderNotConfiguredError extends Error {
  constructor() {
    super("No email provider is configured (EMAIL_PROVIDER is unset).");
    this.name = "EmailProviderNotConfiguredError";
  }
}

/**
 * Google Workspace SMTP relay (smtp-relay.gmail.com:587, STARTTLS). Requires
 * "SMTP Authentication" to be enabled for this workspace (Admin console →
 * Apps → Google Workspace → Gmail → Routing → SMTP relay service) and a
 * mailbox app password for `user` — see .env.example for the exact vars.
 *
 * The relay validates the authenticated `user` as the sender unless the
 * workspace has "Allow users to send mail from a different address"
 * enabled; `fromEmail` therefore defaults to `user` and should only be set
 * to something else once that's configured (or a Gmail "Send mail as"
 * alias exists for `user`).
 */
class GoogleWorkspaceEmailProvider implements EmailProvider {
  private readonly transporter: Transporter;

  constructor(
    private readonly user: string,
    appPassword: string,
    private readonly fromEmail: string,
    port: number,
  ) {
    // Port 465 is implicit TLS from the first byte (secure: true); every
    // other port (587, 25) uses plaintext-then-STARTTLS (secure: false,
    // requireTLS: true so a relay that can't upgrade fails instead of
    // silently sending in the clear). Configurable because some hosts block
    // 587 outbound (the classic anti-spam port block) while allowing 465.
    const secure = port === 465;
    this.transporter = nodemailer.createTransport({
      host: "smtp-relay.gmail.com",
      port,
      secure,
      requireTLS: secure ? undefined : true,
      auth: { user, pass: appPassword },
      // Without these, a blocked/unreachable network path hangs the whole
      // send (nodemailer's own default connection timeout is 2 minutes) —
      // since callers await this inline from a synchronous webhook handler,
      // that turns a network problem into a hung HTTP request instead of a
      // fast, logged failure. 10s is generous for reaching Google's relay.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }

  async sendEmail(to: string, subject: string, html: string, opts: EmailSendOptions = {}): Promise<EmailSendResult> {
    const fromEmail = opts.fromEmailOverride ?? this.fromEmail;
    const info = await this.transporter.sendMail({
      from: opts.fromName ? { name: opts.fromName, address: fromEmail } : fromEmail,
      to,
      subject,
      html,
      // A plain-text alternative alongside the HTML part — an HTML-only
      // body is itself a well-known spam signal, on top of being what a
      // new sending identity can least afford.
      text: htmlToPlainText(html),
      replyTo: opts.replyTo,
      inReplyTo: opts.inReplyTo,
      references: opts.references,
      ...(opts.unsubscribeUrl
        ? { headers: { "List-Unsubscribe": `<${opts.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }
        : {}),
    });

    if (!info.messageId) {
      throw new Error("Google Workspace SMTP send response missing messageId.");
    }
    return { messageId: info.messageId };
  }
}

/**
 * Google Workspace via the Gmail API over HTTPS (port 443), authenticated
 * as the mailbox connected through the /auth/google OAuth flow
 * (gmail-oauth.routes.ts) — sends as whichever account granted that
 * consent, same as the SMTP relay authenticates as `user`. Built to work
 * around Railway blocking outbound SMTP entirely (confirmed: both 587 and
 * 465 time out) — HTTPS to Google's API isn't blocked the way raw SMTP is.
 *
 * Builds and sends a raw RFC 5322 message ourselves rather than using a
 * higher-level Gmail "send email" helper, since the API's users.messages.send
 * only accepts a base64url-encoded raw MIME message — this mirrors what
 * nodemailer did internally for the SMTP path, just constructed by hand.
 */
/**
 * RFC 2047 encoded-word — email headers are ASCII-only per RFC 5322, so a
 * raw UTF-8 byte sequence placed directly in one (e.g. an em dash in a
 * subject line) gets misread as Latin-1 by mail clients, producing
 * mojibake like "Ã¢Â€Â”". Skips encoding for pure-ASCII values so the
 * common case stays a plain, readable header — only non-ASCII values pay
 * for it.
 */
function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

class GmailApiEmailProvider implements EmailProvider {
  constructor(private readonly fromEmail: string) {}

  async sendEmail(to: string, subject: string, html: string, opts: EmailSendOptions = {}): Promise<EmailSendResult> {
    // Gmail API's send response gives Gmail's own internal message id, not
    // an RFC 5322 Message-ID header value — generating our own up front
    // means every caller (reply threading, the send-record idempotency
    // handle) gets the same kind of value the SMTP path's nodemailer
    // transport handed back, with no extra round-trip to look it up.
    const fromEmail = opts.fromEmailOverride ?? this.fromEmail;
    const domain = fromEmail.split("@")[1] ?? "tryark.com";
    const messageId = `<${randomUUID()}@${domain}>`;
    const wrapMessageId = (id: string) => (id.startsWith("<") ? id : `<${id}>`);
    const from = opts.fromName ? `"${encodeHeaderValue(opts.fromName)}" <${fromEmail}>` : fromEmail;
    const boundary = `ark-${randomUUID()}`;

    const headers = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${encodeHeaderValue(subject)}`,
      `Message-ID: ${messageId}`,
      opts.replyTo ? `Reply-To: ${opts.replyTo}` : null,
      opts.inReplyTo ? `In-Reply-To: ${wrapMessageId(opts.inReplyTo)}` : null,
      opts.references ? `References: ${wrapMessageId(opts.references)}` : null,
      // A one-click List-Unsubscribe is a strong positive signal to
      // mailbox providers for automated mail — see EmailSendOptions'
      // unsubscribeUrl doc for why this matters more than it looks.
      opts.unsubscribeUrl ? `List-Unsubscribe: <${opts.unsubscribeUrl}>` : null,
      opts.unsubscribeUrl ? `List-Unsubscribe-Post: List-Unsubscribe=One-Click` : null,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ].filter((header): header is string => header !== null);

    // multipart/alternative with a text/plain part alongside the HTML: an
    // HTML-only body is itself a well-known spam signal, on top of being
    // what a freshly-connected sending identity can least afford.
    const body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      htmlToPlainText(html),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "",
      html,
      `--${boundary}--`,
    ].join("\r\n");

    const raw = [...headers, "", body].join("\r\n");

    await createGmailClient().users.messages.send({
      userId: "me",
      requestBody: { raw: encodeMessage(raw) },
    });

    return { messageId };
  }
}

/**
 * Which persona is sending — lets Alexis and Sophie show different display
 * names (and, if the workspace has separate "send mail as" aliases
 * configured, different addresses via the per-persona *_FROM_EMAIL vars)
 * while sharing one authenticated mailbox by default. See .env.example.
 * "system" is the non-patient-facing identity for staff-facing transactional
 * mail (user invitations, and any future account-management email).
 */
export type EmailPersona = "alexis" | "sophie" | "system";

const PERSONA_DEFAULT_NAME: Record<EmailPersona, string> = {
  alexis: "Alexis at Ark Health",
  sophie: "Sophie at Ark Health",
  system: "Ark Health",
};

const PERSONA_ENV_KEY: Record<EmailPersona, string> = {
  alexis: "GOOGLE_WORKSPACE_ALEXIS_FROM_NAME",
  sophie: "GOOGLE_WORKSPACE_SOPHIE_FROM_NAME",
  system: "GOOGLE_WORKSPACE_SYSTEM_FROM_NAME",
};

function personaFromName(persona: EmailPersona): string {
  return process.env[PERSONA_ENV_KEY[persona]] ?? PERSONA_DEFAULT_NAME[persona];
}

/**
 * Wraps a provider so every caller's send failure alerts to Slack — same
 * reasoning as sms-provider.ts's withFailureAlert. Re-throws unchanged.
 */
function withFailureAlert(provider: EmailProvider): EmailProvider {
  return {
    async sendEmail(to, subject, html, opts) {
      try {
        return await provider.sendEmail(to, subject, html, opts);
      } catch (err) {
        void notifySlack(`Email send failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  };
}

export function getEmailProvider(persona: EmailPersona): { provider: EmailProvider; fromName: string } {
  const providerName = process.env.EMAIL_PROVIDER;
  if (!providerName) {
    throw new EmailProviderNotConfiguredError();
  }

  if (providerName === "gmail_api") {
    // The mailbox connected via /auth/google (gmail-oauth.routes.ts) —
    // reuses GOOGLE_WORKSPACE_SMTP_USER as the known address rather than
    // requiring a separate var, since it's the same mailbox either way.
    const fromEmail = process.env.GOOGLE_GMAIL_FROM_EMAIL ?? process.env.GOOGLE_WORKSPACE_SMTP_USER;
    const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "GOOGLE_REFRESH_TOKEN"].filter((key) => !process.env[key]);
    if (!fromEmail || missing.length > 0) {
      const missingList = [...(fromEmail ? [] : ["GOOGLE_GMAIL_FROM_EMAIL or GOOGLE_WORKSPACE_SMTP_USER"]), ...missing];
      throw new Error(`EMAIL_PROVIDER is 'gmail_api' but ${missingList.join(", ")} is not set.`);
    }
    return { provider: withFailureAlert(new GmailApiEmailProvider(fromEmail)), fromName: personaFromName(persona) };
  }

  if (providerName === "google_workspace") {
    const user = process.env.GOOGLE_WORKSPACE_SMTP_USER;
    const rawAppPassword = process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD;
    if (!user || !rawAppPassword) {
      throw new Error("EMAIL_PROVIDER is 'google_workspace' but GOOGLE_WORKSPACE_SMTP_USER/GOOGLE_WORKSPACE_SMTP_APP_PASSWORD is not set.");
    }
    // Google shows an app password as 4 space-separated groups — stripped
    // here the same way email-inbound.service.ts's imapConfigs strips it
    // for the identical env var, so pasting it exactly as displayed doesn't
    // silently fail auth against the SMTP relay either.
    const appPassword = rawAppPassword.replace(/\s+/g, "");
    const fromEmail = process.env.GOOGLE_WORKSPACE_FROM_EMAIL ?? user;
    const port = process.env.GOOGLE_WORKSPACE_SMTP_PORT ? Number(process.env.GOOGLE_WORKSPACE_SMTP_PORT) : 587;
    return { provider: withFailureAlert(new GoogleWorkspaceEmailProvider(user, appPassword, fromEmail, port)), fromName: personaFromName(persona) };
  }

  throw new EmailProviderNotConfiguredError();
}
