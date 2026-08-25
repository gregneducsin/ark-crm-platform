import { describe, expect, it, beforeAll } from "vitest";
import { signUnsubscribeToken, verifyUnsubscribeToken, buildUnsubscribeUrl } from "./unsubscribe.js";

beforeAll(() => {
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-unsubscribe-secret";
  process.env.INTAKE_LINK_BASE_URL = "http://localhost:3000";
});

describe("signUnsubscribeToken / verifyUnsubscribeToken", () => {
  it("round-trips a personId through sign then verify", () => {
    const personId = "11111111-1111-1111-1111-111111111111";
    const token = signUnsubscribeToken(personId);
    expect(verifyUnsubscribeToken(token)).toBe(personId);
  });

  it("rejects a tampered personId segment", () => {
    const token = signUnsubscribeToken("11111111-1111-1111-1111-111111111111");
    const [, signature] = token.split(".");
    const tampered = `${Buffer.from("22222222-2222-2222-2222-222222222222", "utf8").toString("base64url")}.${signature}`;
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = signUnsubscribeToken("11111111-1111-1111-1111-111111111111");
    const [personIdB64] = token.split(".");
    expect(verifyUnsubscribeToken(`${personIdB64}.deadbeef`)).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(verifyUnsubscribeToken("not-a-real-token")).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = signUnsubscribeToken("11111111-1111-1111-1111-111111111111");
    process.env.EMAIL_UNSUBSCRIBE_SECRET = "a-different-secret";
    expect(verifyUnsubscribeToken(token)).toBeNull();
    process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-unsubscribe-secret";
  });
});

describe("buildUnsubscribeUrl", () => {
  it("builds a full URL off INTAKE_LINK_BASE_URL that verifies back to the same personId", () => {
    const personId = "33333333-3333-3333-3333-333333333333";
    const url = buildUnsubscribeUrl(personId);
    expect(url.startsWith("http://localhost:3000/unsubscribe/")).toBe(true);
    const token = url.split("/unsubscribe/")[1];
    expect(verifyUnsubscribeToken(token)).toBe(personId);
  });

  it("throws when INTAKE_LINK_BASE_URL isn't configured", () => {
    const saved = process.env.INTAKE_LINK_BASE_URL;
    delete process.env.INTAKE_LINK_BASE_URL;
    expect(() => buildUnsubscribeUrl("some-person-id")).toThrow(/INTAKE_LINK_BASE_URL/);
    process.env.INTAKE_LINK_BASE_URL = saved;
  });
});
