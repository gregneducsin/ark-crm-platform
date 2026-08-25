import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { getEmailProvider, EmailProviderNotConfiguredError } from "./email-provider.js";
import {
  renderOrderReceivedEmail,
  renderPrescriptionWrittenEmail,
  renderOrderShippedEmail,
  renderAbandonedCartOpenerEmail,
  renderAbandonedCartUrgencyEmail,
  renderAbandonedCartEducationalEmail,
  renderAbandonedCartPlanComparisonEmail,
} from "./email/templates.js";

const sendMock = vi.fn().mockResolvedValue({ data: { id: "gmail-msg-id" } });
vi.mock("googleapis", () => ({
  google: {
    auth: { OAuth2: class MockOAuth2 { setCredentials() {} } },
    gmail: () => ({ users: { messages: { send: sendMock } } }),
  },
}));

const notifySlackMock = vi.fn();
vi.mock("./slack.js", () => ({ notifySlack: (...args: unknown[]) => notifySlackMock(...args) }));

function decodeRawPayload(): string {
  const raw = sendMock.mock.calls.at(-1)?.[0].requestBody.raw as string;
  const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf8");
}

const ENV_KEYS = [
  "EMAIL_PROVIDER",
  "GOOGLE_WORKSPACE_SMTP_USER",
  "GOOGLE_WORKSPACE_SMTP_APP_PASSWORD",
  "GOOGLE_WORKSPACE_FROM_EMAIL",
  "GOOGLE_WORKSPACE_ALEXIS_FROM_NAME",
  "GOOGLE_WORKSPACE_SOPHIE_FROM_NAME",
  "GOOGLE_GMAIL_FROM_EMAIL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "GOOGLE_REFRESH_TOKEN",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("getEmailProvider", () => {
  it("throws EmailProviderNotConfiguredError when EMAIL_PROVIDER is unset", () => {
    expect(() => getEmailProvider("alexis")).toThrow(EmailProviderNotConfiguredError);
  });

  it("throws EmailProviderNotConfiguredError for an unknown provider name", () => {
    process.env.EMAIL_PROVIDER = "sendgrid";
    expect(() => getEmailProvider("alexis")).toThrow(EmailProviderNotConfiguredError);
  });

  describe("google_workspace (SMTP)", () => {
    it("throws a clear error when the mailbox credentials are missing", () => {
      process.env.EMAIL_PROVIDER = "google_workspace";
      expect(() => getEmailProvider("alexis")).toThrow(/GOOGLE_WORKSPACE_SMTP_USER/);
    });

    it("defaults to persona-specific display names", () => {
      process.env.EMAIL_PROVIDER = "google_workspace";
      process.env.GOOGLE_WORKSPACE_SMTP_USER = "bot@example.com";
      process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD = "app-password";

      expect(getEmailProvider("alexis").fromName).toBe("Alexis at Ark Health");
      expect(getEmailProvider("sophie").fromName).toBe("Sophie at Ark Health");
    });

    it("uses a per-persona GOOGLE_WORKSPACE_*_FROM_NAME override when set", () => {
      process.env.EMAIL_PROVIDER = "google_workspace";
      process.env.GOOGLE_WORKSPACE_SMTP_USER = "bot@example.com";
      process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD = "app-password";
      process.env.GOOGLE_WORKSPACE_ALEXIS_FROM_NAME = "Ark Sales";

      expect(getEmailProvider("alexis").fromName).toBe("Ark Sales");
      expect(getEmailProvider("sophie").fromName).toBe("Sophie at Ark Health");
    });
  });

  describe("gmail_api (Gmail API over HTTPS)", () => {
    it("throws a clear error listing every missing OAuth var", () => {
      process.env.EMAIL_PROVIDER = "gmail_api";
      expect(() => getEmailProvider("alexis")).toThrow(/GOOGLE_GMAIL_FROM_EMAIL or GOOGLE_WORKSPACE_SMTP_USER.*GOOGLE_CLIENT_ID.*GOOGLE_CLIENT_SECRET.*GOOGLE_REDIRECT_URI.*GOOGLE_REFRESH_TOKEN/s);
    });

    it("throws when only the from-email is missing, with the OAuth vars set", () => {
      process.env.EMAIL_PROVIDER = "gmail_api";
      process.env.GOOGLE_CLIENT_ID = "client-id";
      process.env.GOOGLE_CLIENT_SECRET = "client-secret";
      process.env.GOOGLE_REDIRECT_URI = "https://example.com/auth/google/callback";
      process.env.GOOGLE_REFRESH_TOKEN = "refresh-token";
      expect(() => getEmailProvider("alexis")).toThrow(/GOOGLE_GMAIL_FROM_EMAIL or GOOGLE_WORKSPACE_SMTP_USER/);
    });

    it("falls back to GOOGLE_WORKSPACE_SMTP_USER for the from-email when GOOGLE_GMAIL_FROM_EMAIL is unset", () => {
      process.env.EMAIL_PROVIDER = "gmail_api";
      process.env.GOOGLE_WORKSPACE_SMTP_USER = "alexism@start.tryark.com";
      process.env.GOOGLE_CLIENT_ID = "client-id";
      process.env.GOOGLE_CLIENT_SECRET = "client-secret";
      process.env.GOOGLE_REDIRECT_URI = "https://example.com/auth/google/callback";
      process.env.GOOGLE_REFRESH_TOKEN = "refresh-token";

      expect(() => getEmailProvider("alexis")).not.toThrow();
    });

    it("uses GOOGLE_GMAIL_FROM_EMAIL over GOOGLE_WORKSPACE_SMTP_USER when both are set, and persona display names still apply", () => {
      process.env.EMAIL_PROVIDER = "gmail_api";
      process.env.GOOGLE_GMAIL_FROM_EMAIL = "sophie@start.tryark.com";
      process.env.GOOGLE_WORKSPACE_SMTP_USER = "alexism@start.tryark.com";
      process.env.GOOGLE_CLIENT_ID = "client-id";
      process.env.GOOGLE_CLIENT_SECRET = "client-secret";
      process.env.GOOGLE_REDIRECT_URI = "https://example.com/auth/google/callback";
      process.env.GOOGLE_REFRESH_TOKEN = "refresh-token";

      expect(getEmailProvider("sophie").fromName).toBe("Sophie at Ark Health");
    });

    describe("sendEmail header encoding", () => {
      function configuredProvider() {
        process.env.EMAIL_PROVIDER = "gmail_api";
        process.env.GOOGLE_WORKSPACE_SMTP_USER = "alexism@start.tryark.com";
        process.env.GOOGLE_CLIENT_ID = "client-id";
        process.env.GOOGLE_CLIENT_SECRET = "client-secret";
        process.env.GOOGLE_REDIRECT_URI = "https://example.com/auth/google/callback";
        process.env.GOOGLE_REFRESH_TOKEN = "refresh-token";
        return getEmailProvider("alexis").provider;
      }

      it("RFC 2047-encodes a subject containing non-ASCII characters, instead of placing raw UTF-8 bytes in the header", async () => {
        sendMock.mockClear();
        const provider = configuredProvider();
        await provider.sendEmail("customer@example.com", "Welcome — start now", "<p>hi</p>");

        const decoded = decodeRawPayload();
        const subjectLine = decoded.split("\r\n").find((line) => line.startsWith("Subject:"));
        expect(subjectLine).toMatch(/^Subject: =\?UTF-8\?B\?/);
        // Decoding the encoded-word back out must reproduce the original text exactly.
        const encodedWord = subjectLine!.replace("Subject: =?UTF-8?B?", "").replace("?=", "");
        expect(Buffer.from(encodedWord, "base64").toString("utf8")).toBe("Welcome — start now");
      });

      it("leaves a pure-ASCII subject as a plain, unencoded header", async () => {
        sendMock.mockClear();
        const provider = configuredProvider();
        await provider.sendEmail("customer@example.com", "Welcome to Ark Health", "<p>hi</p>");

        const decoded = decodeRawPayload();
        expect(decoded).toContain("Subject: Welcome to Ark Health\r\n");
      });

      it("alerts Slack on a send failure, then still rejects with the original error", async () => {
        notifySlackMock.mockClear();
        sendMock.mockRejectedValueOnce(new Error("Gmail API quota exceeded"));
        const provider = configuredProvider();

        await expect(provider.sendEmail("customer@example.com", "Subject", "<p>hi</p>")).rejects.toThrow(/quota exceeded/);
        expect(notifySlackMock).toHaveBeenCalledTimes(1);
        expect(notifySlackMock.mock.calls[0][0]).toMatch(/Email send failed/);
      });

      it("sends a multipart/alternative message with both a plain-text and an HTML part, not HTML-only", async () => {
        sendMock.mockClear();
        const provider = configuredProvider();
        await provider.sendEmail("customer@example.com", "Welcome", "<p>Hi <b>there</b></p>");

        const decoded = decodeRawPayload();
        expect(decoded).toMatch(/Content-Type: multipart\/alternative; boundary="[^"]+"/);
        expect(decoded).toContain('Content-Type: text/plain; charset="UTF-8"');
        expect(decoded).toContain("Hi there");
        expect(decoded).toContain('Content-Type: text/html; charset="UTF-8"');
        expect(decoded).toContain("<p>Hi <b>there</b></p>");
      });

      it("adds List-Unsubscribe and List-Unsubscribe-Post headers when an unsubscribeUrl is given", async () => {
        sendMock.mockClear();
        const provider = configuredProvider();
        await provider.sendEmail("customer@example.com", "Welcome", "<p>hi</p>", { unsubscribeUrl: "http://localhost:3000/unsubscribe/abc.def" });

        const decoded = decodeRawPayload();
        expect(decoded).toContain("List-Unsubscribe: <http://localhost:3000/unsubscribe/abc.def>");
        expect(decoded).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
      });

      it("omits List-Unsubscribe headers entirely when no unsubscribeUrl is given", async () => {
        sendMock.mockClear();
        const provider = configuredProvider();
        await provider.sendEmail("customer@example.com", "Welcome", "<p>hi</p>");

        const decoded = decodeRawPayload();
        expect(decoded).not.toContain("List-Unsubscribe");
      });

      it("every real trigger-email subject in the codebase round-trips correctly through the raw MIME send path", async () => {
        const unsubUrl = "http://localhost:3000/unsubscribe/abc.def";
        const ctaUrl = "http://localhost:3000/go/abc123";
        const realSubjects = [
          renderOrderReceivedEmail("Jamie", unsubUrl).subject,
          renderPrescriptionWrittenEmail("Jamie", unsubUrl).subject,
          renderOrderShippedEmail("Jamie", "1Z999AA10123456784", unsubUrl).subject,
          renderAbandonedCartOpenerEmail("Jamie", ctaUrl, unsubUrl).subject,
          renderAbandonedCartUrgencyEmail("Jamie", ctaUrl, unsubUrl).subject,
          renderAbandonedCartEducationalEmail("Jamie", ctaUrl, unsubUrl).subject,
          renderAbandonedCartPlanComparisonEmail("Jamie", ctaUrl, unsubUrl).subject,
        ];

        const provider = configuredProvider();
        for (const subject of realSubjects) {
          sendMock.mockClear();
          await provider.sendEmail("customer@example.com", subject, "<p>hi</p>");
          const decoded = decodeRawPayload();
          const subjectLine = decoded.split("\r\n").find((line) => line.startsWith("Subject:"))!;

          if (subjectLine.startsWith("Subject: =?UTF-8?B?")) {
            const encodedWord = subjectLine.replace("Subject: =?UTF-8?B?", "").replace("?=", "");
            expect(Buffer.from(encodedWord, "base64").toString("utf8")).toBe(subject);
          } else {
            expect(subjectLine).toBe(`Subject: ${subject}`);
          }
        }
      });
    });
  });
});
