import { describe, it, expect } from "vitest";
import { stripEmDashes } from "./text-sanitize.js";

describe("stripEmDashes", () => {
  it("replaces an em dash with a comma", () => {
    expect(stripEmDashes("Great question — here's the answer.")).toBe("Great question, here's the answer.");
  });

  it("replaces an en dash with a comma", () => {
    expect(stripEmDashes("Semaglutide – a popular choice.")).toBe("Semaglutide, a popular choice.");
  });

  it("handles multiple dashes in the same string", () => {
    expect(stripEmDashes("One — two — three")).toBe("One, two, three");
  });

  it("leaves text with no dash untouched", () => {
    expect(stripEmDashes("Nothing to change here.")).toBe("Nothing to change here.");
  });

  it("passes null through unchanged", () => {
    expect(stripEmDashes(null)).toBeNull();
  });
});
