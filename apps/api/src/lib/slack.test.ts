import { describe, expect, it, afterEach, vi } from "vitest";
import { notifySlack, notifySmsSlack } from "./slack.js";

describe("notifySlack", () => {
  const original = process.env.SLACK_WEBHOOK_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.SLACK_WEBHOOK_URL;
    else process.env.SLACK_WEBHOOK_URL = original;
    vi.unstubAllGlobals();
  });

  it("does nothing when SLACK_WEBHOOK_URL is unset", async () => {
    delete process.env.SLACK_WEBHOOK_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await notifySlack("hello");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs the message as JSON to the configured webhook URL", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/triggers/T000/1/abc";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await notifySlack("something happened");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.slack.com/triggers/T000/1/abc",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "Content-Type": "application/json" }) }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ message: "something happened" });
  });

  it("never throws when Slack responds with a non-2xx status", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/triggers/T000/1/abc";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    await expect(notifySlack("hello")).resolves.toBeUndefined();
  });

  it("never throws when the fetch itself rejects", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/triggers/T000/1/abc";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(notifySlack("hello")).resolves.toBeUndefined();
  });

  it("truncates a message past Slack's block-text limit instead of letting the workflow step silently fail", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/triggers/T000/1/abc";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    // A raw Postgres/SMTP error message forwarded verbatim can easily run
    // past Slack's 3000-character section-text cap — this is exactly what
    // was silently dropping alerts with an opaque "Input validation error /
    // invalid_blocks" in the Workflow Builder step, with nothing showing up
    // in our own logs since the webhook POST itself always succeeds.
    const longMessage = "x".repeat(5000);
    await notifySlack(longMessage);

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body).message as string;
    expect(sent.length).toBeLessThan(3000);
    expect(sent.endsWith("… (truncated)")).toBe(true);
  });

  it("leaves a short message untouched", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/triggers/T000/1/abc";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await notifySlack("short message");

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ message: "short message" });
  });
});

describe("notifySmsSlack", () => {
  const originalWebhook = process.env.SLACK_WEBHOOK_URL;
  const originalDisabled = process.env.SMS_SLACK_ALERTS_DISABLED;

  afterEach(() => {
    if (originalWebhook === undefined) delete process.env.SLACK_WEBHOOK_URL;
    else process.env.SLACK_WEBHOOK_URL = originalWebhook;
    if (originalDisabled === undefined) delete process.env.SMS_SLACK_ALERTS_DISABLED;
    else process.env.SMS_SLACK_ALERTS_DISABLED = originalDisabled;
    vi.unstubAllGlobals();
  });

  it("forwards to notifySlack when SMS_SLACK_ALERTS_DISABLED is unset", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/triggers/T000/1/abc";
    delete process.env.SMS_SLACK_ALERTS_DISABLED;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await notifySmsSlack("SMS send failed — +15551234567");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not call Slack at all when SMS_SLACK_ALERTS_DISABLED=true, even with a webhook configured — this is the per-app switch for muting only SMS alerts", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/triggers/T000/1/abc";
    process.env.SMS_SLACK_ALERTS_DISABLED = "true";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await notifySmsSlack("SMS send failed — +15551234567");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still no-ops when SMS_SLACK_ALERTS_DISABLED is unset but SLACK_WEBHOOK_URL is also unset", async () => {
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.SMS_SLACK_ALERTS_DISABLED;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await notifySmsSlack("SMS send failed — +15551234567");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
