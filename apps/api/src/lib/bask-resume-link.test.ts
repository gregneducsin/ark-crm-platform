import { describe, expect, it } from "vitest";
import { extractBaskResumeLink } from "./bask-resume-link.js";

describe("extractBaskResumeLink", () => {
  it.each(["Data Magic Link", "dataMagicLink", "data_magic_link", "magicLink", "magic_link", "resumeUrl", "resume_link", "sessionLink"])("reads the link from %s", (key) => {
    expect(extractBaskResumeLink({ [key]: "https://bask.example.com/resume?token=abc" })).toBe("https://bask.example.com/resume?token=abc");
  });

  it("prefers a known name over a loosely matching one", () => {
    expect(extractBaskResumeLink({ resumeThing: "https://b.example.com/loose", magicLink: "https://b.example.com/exact" })).toBe("https://b.example.com/exact");
  });

  it("falls back to any key mentioning magic or resume", () => {
    expect(extractBaskResumeLink({ patientMagicLoginUrl: "https://b.example.com/m?t=1" })).toBe("https://b.example.com/m?t=1");
  });

  it("ignores an unfilled Bask template token left in the field", () => {
    expect(extractBaskResumeLink({ "Data Magic Link": "{{data.magicLink}}" })).toBeNull();
  });

  it("ignores values that are not absolute http(s) URLs", () => {
    expect(extractBaskResumeLink({ magicLink: "abc123token" })).toBeNull();
    expect(extractBaskResumeLink({ magicLink: "javascript:alert(1)" })).toBeNull();
    expect(extractBaskResumeLink({ magicLink: 42 })).toBeNull();
    expect(extractBaskResumeLink({ magicLink: `https://b.example.com/${"x".repeat(2100)}` })).toBeNull();
  });

  it("returns null when there is no payload or no matching key", () => {
    expect(extractBaskResumeLink(null)).toBeNull();
    expect(extractBaskResumeLink([])).toBeNull();
    expect(extractBaskResumeLink({ email: "a@example.com" })).toBeNull();
  });
});
