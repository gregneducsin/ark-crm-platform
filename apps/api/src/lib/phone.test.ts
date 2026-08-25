import { describe, expect, it } from "vitest";
import { normalizePhone, phoneMatchKey } from "./phone.js";

describe("normalizePhone", () => {
  it("adds +1 to a bare 10-digit number", () => {
    expect(normalizePhone("2679691493")).toBe("+12679691493");
  });

  it("normalizes a formatted 10-digit number", () => {
    expect(normalizePhone("(267) 969-1493")).toBe("+12679691493");
  });

  it("adds + to an 11-digit number already starting with 1", () => {
    expect(normalizePhone("12679691493")).toBe("+12679691493");
  });

  it("leaves an already-normalized E.164 number unchanged", () => {
    expect(normalizePhone("+12679691493")).toBe("+12679691493");
  });

  it("passes through unrecognized formats trimmed but otherwise unchanged", () => {
    expect(normalizePhone("  +44 20 7946 0958  ")).toBe("+44 20 7946 0958");
  });
});

describe("phoneMatchKey", () => {
  it("returns the same key regardless of formatting", () => {
    const key = phoneMatchKey("+12679691493");
    expect(phoneMatchKey("2679691493")).toBe(key);
    expect(phoneMatchKey("(267) 969-1493")).toBe(key);
    expect(phoneMatchKey("267-969-1493")).toBe(key);
  });

  it("is 10 digits long for a US number", () => {
    expect(phoneMatchKey("+12679691493")).toHaveLength(10);
  });
});
