import crypto from "crypto";
import { notifySmsSlack } from "./slack.js";

/**
 * iBluSend's Calls API (FaceTime Audio, private beta) — a different origin
 * (https://iblusend.com/api/v1, "the app origin") from the plain messaging
 * endpoint in sms-provider.ts (api.iblusend.com/functions/v1), but the same
 * Bearer key (IBLUSEND_API_KEY) once calling is enabled on it.
 *
 * This only ever *prepares* a call — POST /api/v1/calls creates a five-
 * minute session and returns a confirmation_url. It never dials by itself:
 * a signed-in human must open that URL and press "Start call" for anything
 * to actually ring. That's iBluSend's own safety model (every call runs on
 * a real Apple ID), not a limitation to work around — this integration is a
 * click-to-call button, not an autodialer, by design.
 */

export interface PrepareCallResult {
  readonly callId: string;
  readonly confirmationUrl: string;
}

export class CallsNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`${missing} is not set.`);
    this.name = "CallsNotConfiguredError";
  }
}

/**
 * A fresh Idempotency-Key per call: this fires once per "Call" button click,
 * and each click is a genuinely new call attempt, not a retry of a prior
 * one — retries of the *same* attempt (e.g. a network blip on our end)
 * would need to reuse the same key instead, but that's not the case here.
 *
 * line_id is omitted here on purpose — Ark's IBLUSEND_API_KEY now has a
 * default calling line bound to it directly in iBluSend's dashboard
 * (Settings → Developer → API Keys), which is what the docs mean by
 * "optional when the key has a default line." An earlier version of this
 * required an IBLUSEND_CALLING_LINE_ID env var and sent it explicitly, from
 * before that default was configured — no longer needed now that the key
 * itself carries one. If IBLUSEND_CALLING_LINE_ID is set anyway (e.g. a
 * second line added later without its own key), it's still honored.
 */
export async function prepareCall(to: string, contactName: string, clientReference: string): Promise<PrepareCallResult> {
  const apiKey = process.env.IBLUSEND_API_KEY;
  if (!apiKey) {
    throw new CallsNotConfiguredError("IBLUSEND_API_KEY");
  }
  const lineId = process.env.IBLUSEND_CALLING_LINE_ID;

  let res: Response;
  try {
    res = await fetch("https://iblusend.com/api/v1/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ to, ...(lineId ? { line_id: lineId } : {}), contact_name: contactName, client_reference: clientReference }),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    void notifySmsSlack(`Call prepare failed — ${to} — ${reason}`);
    throw new Error(`iBluSend call prepare request failed: ${reason}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    void notifySmsSlack(`Call prepare failed — ${to} — ${res.status} ${text}`);
    throw new Error(`iBluSend call prepare failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as { id?: string; confirmation_url?: string };
  if (!json.id || !json.confirmation_url) {
    void notifySmsSlack(`Call prepare to ${to} got an unexpected iBluSend response shape (missing id/confirmation_url).`);
    throw new Error("iBluSend call prepare succeeded but the response was missing id/confirmation_url.");
  }

  return { callId: json.id, confirmationUrl: json.confirmation_url };
}
