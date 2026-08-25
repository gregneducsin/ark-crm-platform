import { google, type gmail_v1 } from "googleapis";

/**
 * Shared by GmailApiEmailProvider (lib/email-provider.ts, the real send
 * path) and sendGmailTestMessage below (the standalone connection-test
 * endpoint) — one place that knows how to build an authenticated Gmail API
 * client from the OAuth env vars set via the /auth/google connect flow.
 */
export function createGmailClient(): gmail_v1.Gmail {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (
    !clientId ||
    !clientSecret ||
    !redirectUri ||
    !refreshToken
  ) {
    throw new Error(
      "Google Gmail environment variables are missing.",
    );
  }

  const auth = new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri,
  );

  auth.setCredentials({
    refresh_token: refreshToken,
  });

  return google.gmail({
    version: "v1",
    auth,
  });
}

export function encodeMessage(message: string): string {
  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function sendGmailTestMessage(
  recipient: string,
): Promise<{ id: string | null; threadId: string | null }> {
  const to = recipient.trim();

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) ||
    to.includes("\r") ||
    to.includes("\n")
  ) {
    throw new Error("Invalid recipient email address.");
  }

  const message = [
    `To: ${to}`,
    "Subject: Gmail API connection test",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    "Your Google Workspace Gmail API connection is working.",
  ].join("\r\n");

  const result = await createGmailClient()
    .users.messages.send({
      userId: "me",
      requestBody: {
        raw: encodeMessage(message),
      },
    });

  return {
    id: result.data.id ?? null,
    threadId: result.data.threadId ?? null,
  };
}