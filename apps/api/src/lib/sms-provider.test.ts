import { describe, expect, it, afterEach, vi } from "vitest";
import { getSmsProvider, SmsProviderNotConfiguredError } from "./sms-provider.js";

const notifySlackMock = vi.fn();
vi.mock("./slack.js", () => ({ notifySlack: (...args: unknown[]) => notifySlackMock(...args) }));

describe("getSmsProvider", () => {
  const originalProvider = process.env.SMS_PROVIDER;
  const originalApiKey = process.env.IBLUSEND_API_KEY;

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.SMS_PROVIDER;
    else process.env.SMS_PROVIDER = originalProvider;
    if (originalApiKey === undefined) delete process.env.IBLUSEND_API_KEY;
    else process.env.IBLUSEND_API_KEY = originalApiKey;
    vi.unstubAllGlobals();
  });

  it("throws SmsProviderNotConfiguredError when SMS_PROVIDER is unset", () => {
    delete process.env.SMS_PROVIDER;
    expect(() => getSmsProvider()).toThrow(SmsProviderNotConfiguredError);
  });

  it("throws SmsProviderNotConfiguredError for an unrecognized provider name", () => {
    process.env.SMS_PROVIDER = "sendblue";
    expect(() => getSmsProvider()).toThrow(SmsProviderNotConfiguredError);
  });

  it("throws a configuration error when SMS_PROVIDER=iblusend but IBLUSEND_API_KEY is unset", () => {
    process.env.SMS_PROVIDER = "iblusend";
    delete process.env.IBLUSEND_API_KEY;
    expect(() => getSmsProvider()).toThrow(/IBLUSEND_API_KEY/);
  });

  it("alerts Slack when SMS_PROVIDER is unset, not just a warn log — this is exactly the failure mode that went unnoticed in production", () => {
    notifySlackMock.mockClear();
    delete process.env.SMS_PROVIDER;
    expect(() => getSmsProvider()).toThrow();
    expect(notifySlackMock).toHaveBeenCalledTimes(1);
    expect(notifySlackMock.mock.calls[0][0]).toMatch(/SMS send failed/);
  });

  it("alerts Slack when SMS_PROVIDER=iblusend but IBLUSEND_API_KEY is unset", () => {
    notifySlackMock.mockClear();
    process.env.SMS_PROVIDER = "iblusend";
    delete process.env.IBLUSEND_API_KEY;
    expect(() => getSmsProvider()).toThrow();
    expect(notifySlackMock).toHaveBeenCalledTimes(1);
    expect(notifySlackMock.mock.calls[0][0]).toMatch(/SMS send failed/);
  });

  it("returns an iBluSend provider when both SMS_PROVIDER and IBLUSEND_API_KEY are set", () => {
    process.env.SMS_PROVIDER = "iblusend";
    process.env.IBLUSEND_API_KEY = "iblu_test_abc123";
    expect(() => getSmsProvider()).not.toThrow();
  });

  describe("IbluSendProvider.sendMessage", () => {
    it("sends a message and returns the provider message id", async () => {
      process.env.SMS_PROVIDER = "iblusend";
      process.env.IBLUSEND_API_KEY = "iblu_test_abc123";

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, message_id: "sim_abc123" }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await getSmsProvider().sendMessage("+15551234567", "Hello there");

      expect(result).toEqual({ providerMessageId: "sim_abc123" });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.iblusend.com/functions/v1/send-message",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer iblu_test_abc123" }),
        }),
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({ phone_number: "+15551234567", content: "Hello there" });
    });

    it("throws when iBluSend responds with a non-2xx status", async () => {
      process.env.SMS_PROVIDER = "iblusend";
      process.env.IBLUSEND_API_KEY = "iblu_test_abc123";

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => '{"error":"rate_limited"}' }),
      );

      await expect(getSmsProvider().sendMessage("+15551234567", "Hello there")).rejects.toThrow(/429/);
    });

    it("throws when the response is missing message_id", async () => {
      process.env.SMS_PROVIDER = "iblusend";
      process.env.IBLUSEND_API_KEY = "iblu_test_abc123";

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }));

      await expect(getSmsProvider().sendMessage("+15551234567", "Hello there")).rejects.toThrow(/message_id/);
    });

    it("alerts Slack on a send failure, then still rejects with the original error", async () => {
      notifySlackMock.mockClear();
      process.env.SMS_PROVIDER = "iblusend";
      process.env.IBLUSEND_API_KEY = "iblu_test_abc123";

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => '{"error":"rate_limited"}' }),
      );

      await expect(getSmsProvider().sendMessage("+15551234567", "Hello there")).rejects.toThrow(/429/);
      expect(notifySlackMock).toHaveBeenCalledTimes(1);
      expect(notifySlackMock.mock.calls[0][0]).toMatch(/SMS send failed/);
    });
  });
});
