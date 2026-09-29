import { describe, it, expect } from "vitest";
import { isSmsReplyReady } from "./reply-pacing.js";
describe("reply quiet period", () => {
  it("waits 45 seconds after local receipt and resets on new inbound", () => {
    const now = 100_000;
    expect(isSmsReplyReady(new Date(now - 44_999), now)).toBe(false);
    expect(isSmsReplyReady(new Date(now - 45_000), now)).toBe(true);
    expect(isSmsReplyReady(new Date(now), now)).toBe(false);
    expect(isSmsReplyReady(new Date(now + 1), now)).toBe(false);
  });
});
