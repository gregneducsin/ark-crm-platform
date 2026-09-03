import { notifySmsSlack } from "./slack.js";

/**
 * Outbound SMS provider abstraction. getSmsProvider() throws until one is
 * wired up (see SMS_PROVIDER env var). Everything that calls this is
 * written as if a real provider already existed, so plugging one in is a
 * one-file change here, not a rewrite of the dispatch pipeline that calls
 * it.
 */

export interface SmsSendResult {
  readonly providerMessageId: string;
}

export interface SmsProvider {
  sendMessage(to: string, body: string): Promise<SmsSendResult>;
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
      throw new Error(`iBluSend send failed: ${res.status} ${text}`);
    }

    const json = (await res.json()) as { message_id?: string };
    if (!json.message_id) {
      throw new Error("iBluSend send response missing message_id.");
    }
    return { providerMessageId: json.message_id };
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
    async sendMessage(to: string, body: string): Promise<SmsSendResult> {
      try {
        return await provider.sendMessage(to, body);
      } catch (err) {
        // Short and identifier-only, not the raw provider error — the full
        // reason is already in the structured logger.warn at the call site;
        // Slack is a ping to go look, not a dump of the error itself (a
        // verbose provider error was also what tripped Slack's own
        // block-text length limit before notifySlack started truncating).
        void notifySmsSlack(`SMS send failed — ${to}`);
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
