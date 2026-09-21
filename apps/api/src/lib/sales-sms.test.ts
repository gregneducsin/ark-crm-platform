import { describe, expect, it, afterEach } from "vitest";
import { isSalesSmsPaused } from "./sales-sms.js";

describe("isSalesSmsPaused", () => {
  const original = process.env.SALES_SMS_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.SALES_SMS_ENABLED;
    else process.env.SALES_SMS_ENABLED = original;
  });

  it("is paused by default when the env var is unset", () => {
    delete process.env.SALES_SMS_ENABLED;
    expect(isSalesSmsPaused()).toBe(true);
  });

  it("is paused for any value other than the exact string 'true'", () => {
    process.env.SALES_SMS_ENABLED = "false";
    expect(isSalesSmsPaused()).toBe(true);
    process.env.SALES_SMS_ENABLED = "1";
    expect(isSalesSmsPaused()).toBe(true);
  });

  it("is not paused when explicitly enabled", () => {
    process.env.SALES_SMS_ENABLED = "true";
    expect(isSalesSmsPaused()).toBe(false);
  });
});
