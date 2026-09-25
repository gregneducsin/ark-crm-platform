import { notifySmsSlack } from "./slack.js";
import { assertPhoneSmsAllowed } from "./sms-opt-out.js";
import { assertScheduledSmsTime } from "./send-window.js";

/**
 * Outbound SMS provider abstraction. getSmsProvider() throws until one is
 * wired up (see SMS_PROVIDER env var). Everything that calls this is
 * written as if a real provider already existed, so plugging one in is a
 * one-file change here, not a rewrite of the dispatch pipeline that calls
 * it.
 */

export interface SmsSendResult {
  /**
   * Null specifically means iBluSend accepted the send (HTTP 200) but its
   * response body didn't have the message_id field in the shape we expect —
   * see the comment on that branch in IbluSendProvider.sendMessage for why
   * this is treated as sent, not thrown as a failure.
   */
  readonly providerMessageId: string | null;
}

/**
 * Extracts a short, human-readable reason from an iBluSend error response —
 * from a JSON body like { error, error_code, detail, ... } — instead of the
 * raw HTTP status and full response body. A rate/cap-limit error_code (e.g.
 * "device_daily_cap_exceeded") collapses to a fixed short label rather than
 * the full sentence, since this is an expected, self-resolving condition,
 * not something that needs the full detail text every time it fires. Any
 * other error keeps its full error/detail text so a genuinely unfamiliar
 * failure still has enough to investigate. Falls back to the raw text when
 * the body isn't the shape we expect (or isn't JSON at all).
 */
function describeIbluSendError(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as { error?: string; error_code?: string; detail?: string };
    if (parsed.error_code && /limit|cap/i.test(parsed.error_code)) {
      return "daily send limit reached";
    }
    if (parsed.error) {
      return parsed.detail ? `${parsed.error} — ${parsed.detail}` : parsed.error;
    }
  } catch {
    // Not JSON (or not the expected shape) — fall through to the raw body.
  }
  return rawBody;
}

export interface SmsProvider {
  sendMessage(to: string, body: string, options?: { scheduled?: boolean }): Promise<SmsSendResult>;
}

export class SmsProviderNotConfiguredError extends Error {
  constructor() {
    super("No SMS provider is configured (SMS_PROVIDER is unset).");
    this.name = "SmsProviderNotConfiguredError";
  }
}

/**
 * iBluSend — sends via the plain /send-message endpoint, not the AI Agent
 * API (/agent-api/messages). The Agent API is the endpoint iBluSend's docs
 * recommend for third-party AI/bot traffic and offers pacing controls
 * (send_mode) the plain endpoint doesn't, but it requires an "AI Agent API"
 * account-level add-on to be separately enabled (Settings → Developer → AI
 * Agent tab) — confirmed against a real 403 agent_api_disabled response in
 * production 2026-08-20. Deliberately not enabling that add-on: Alexis/Sophie's
 * replies are already fully drafted by our own Claude integration before
 * this function is ever called, so there's nothing for iBluSend's AI
 * feature to add. /send-message has no pacing option, but every caller here
 * is a live conversational reply, not paced bulk outreach, so that's not a
 * loss in practice.
 *
 * Field names (phone_number/content) and the path (send-message, no
 * agent-api prefix, no /v1/) are taken directly from iBluSend's
 * "Send-Message API Reference" docs, confirmed 2026-08-20.
 */
class IbluSendProvider implements SmsProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = "https://api.iblusend.com/functions/v1",
  ) {}

  async sendMessage(to: string, body: string): Promise<SmsSendResult> {
    const res = await fetch(`${this.baseUrl}/send-message`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ phone_number: to, content: body }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`iBluSend send failed: ${res.status} ${describeIbluSendError(text)}`);
    }

    // A 200 here means iBluSend accepted and almost certainly dispatched the
    // message — a missing message_id in the body is a response-shape
    // problem (a schema drift on their end, a malformed-but-still-2xx
    // response), not evidence the text didn't go out. Treating this as a
    // thrown failure is exactly what caused a real customer to get the same
    // lead-check-in text three times: every caller in this codebase that
    // retries on a thrown send error (lead-checkin.service.ts, among
    // others) would re-send the identical message on the assumption the
    // first attempt never reached the customer, when it likely had. Alert
    // so someone investigates the response shape, but don't throw — a
    // caller with retry logic must not re-send over this.
    const json: unknown = await res.json().catch(() => null);
    const messageId = json !== null && typeof json === "object" && "message_id" in json
      ? json.message_id
      : null;
    if (typeof messageId !== "string" || !messageId.trim()) {
      void notifySmsSlack(`SMS send to ${to} got an unexpected iBluSend response shape (no message_id) — treating as sent, not retrying. Response body should be checked.`);
      return { providerMessageId: null };
    }
    return { providerMessageId: messageId };
  }
}

/**
 * Wraps a provider so every caller's send failure alerts to Slack, without
 * every one of this app's dozen-plus call sites having to remember to do it
 * themselves. Re-throws unchanged — every existing caller's own try/catch
 * (fail-soft log-and-continue) behaves exactly as before this wrapper.
 */
function withFailureAlert(provider: SmsProvider): SmsProvider {
  return {
    async sendMessage(to: string, body: string, options?: { scheduled?: boolean }): Promise<SmsSendResult> {
      // Final transport gate, shared by automated and staff sends. An opt-out
      // is an intentional suppression, not a provider failure alert.
      await assertPhoneSmsAllowed(to);
      if (options?.scheduled) assertScheduledSmsTime();
      try {
        return await provider.sendMessage(to, body);
      } catch (err) {
        // Includes the actual reason (e.g. "Daily new-contact outreach limit
        // reached") rather than just the phone number — a plain "SMS send
        // failed" ping with no detail meant every occurrence needed a trip
        // into Deploy Logs to find out it was an expected rate limit, not a
        // real problem. notifySlack already truncates long messages, so a
        // verbose provider error can't blow past Slack's block-text limit
        // the way it used to before that truncation existed.
        const reason = err instanceof Error ? err.message : String(err);
        void notifySmsSlack(`SMS send failed — ${to} — ${reason}`);
        throw err;
      }
    },
  };
}

/**
 * Every caller does `getSmsProvider().sendMessage(...)` inside its own
 * try/catch — so when this throws (misconfigured SMS_PROVIDER/API key), the
 * error lands in that same catch and gets logged, exactly like a real send
 * failure. But withFailureAlert below only wraps a provider this function
 * has already returned — it can never run for an error thrown from in here,
 * so a config problem alerted nobody, ever, at any of this app's dozen-plus
 * call sites: a real production gap (real leads got zero outreach —
 * abandoned-cart openers and Alexis's live replies alike — with nothing
 * beyond a warn-level log line to show for it). Alert here too, before
 * throwing, so every SMS failure mode — misconfigured or a real send error —
 * pings the same Slack channel the same way.
 */
export function getSmsProvider(): SmsProvider {
  const provider = process.env.SMS_PROVIDER;
  if (provider === "iblusend") {
    const apiKey = process.env.IBLUSEND_API_KEY;
    if (!apiKey) {
      void notifySmsSlack("SMS send failed — SMS_PROVIDER is 'iblusend' but IBLUSEND_API_KEY is not set.");
      throw new Error("SMS_PROVIDER is 'iblusend' but IBLUSEND_API_KEY is not set.");
    }
    return withFailureAlert(new IbluSendProvider(apiKey));
  }
  void notifySmsSlack(
    provider ? `SMS send failed — unrecognized SMS_PROVIDER value: ${provider}` : "SMS send failed — no SMS provider is configured (SMS_PROVIDER is unset).",
  );
  throw new SmsProviderNotConfiguredError();
}
