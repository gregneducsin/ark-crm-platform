import { describe, expect, it } from "vitest";
import { clampToSendWindow } from "./send-window.js";

/** Formats a Date as its America/New_York wall-clock time, for readable assertions. */
function easternClock(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}
function easternDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

describe("clampToSendWindow", () => {
  it("leaves a mid-morning Eastern time unchanged", () => {
    // 2026-01-15 10:00 ET (EST, UTC-5) = 15:00 UTC
    const input = new Date("2026-01-15T15:00:00.000Z");
    expect(clampToSendWindow(input)).toEqual(input);
  });

  it("leaves a late-night-but-still-allowed Eastern time (11:50pm) unchanged", () => {
    // 2026-01-15 23:50 ET (EST) = 2026-01-16 04:50 UTC
    const input = new Date("2026-01-16T04:50:00.000Z");
    expect(easternClock(input)).toBe("23:50");
    expect(clampToSendWindow(input)).toEqual(input);
  });

  it("snaps 1am Eastern forward to 9am Eastern the same calendar day (standard time)", () => {
    // 2026-01-15 01:00 ET (EST) = 06:00 UTC
    const input = new Date("2026-01-15T06:00:00.000Z");
    expect(easternClock(input)).toBe("01:00");
    const result = clampToSendWindow(input);
    expect(easternDate(result)).toBe(easternDate(input));
    expect(easternClock(result)).toBe("09:00");
  });

  it("snaps exactly midnight Eastern forward to 9am the same day", () => {
    // 2026-01-15 00:00 ET (EST) = 05:00 UTC
    const input = new Date("2026-01-15T05:00:00.000Z");
    expect(easternClock(input)).toBe("00:00");
    const result = clampToSendWindow(input);
    expect(easternDate(result)).toBe(easternDate(input));
    expect(easternClock(result)).toBe("09:00");
  });

  it("snaps 8:59am Eastern forward to 9:00am the same day (just under the window)", () => {
    // 2026-01-15 08:59 ET (EST) = 13:59 UTC
    const input = new Date("2026-01-15T13:59:00.000Z");
    const result = clampToSendWindow(input);
    expect(easternDate(result)).toBe(easternDate(input));
    expect(easternClock(result)).toBe("09:00");
  });

  it("leaves exactly 9:00am Eastern unchanged (the start of the window)", () => {
    // 2026-01-15 09:00 ET (EST) = 14:00 UTC
    const input = new Date("2026-01-15T14:00:00.000Z");
    expect(clampToSendWindow(input)).toEqual(input);
  });

  it("handles the daylight-saving boundary — 2am Eastern in July (EDT, UTC-4) still snaps to 9am Eastern", () => {
    // 2026-07-15 02:00 ET (EDT, UTC-4) = 06:00 UTC
    const input = new Date("2026-07-15T06:00:00.000Z");
    expect(easternClock(input)).toBe("02:00");
    const result = clampToSendWindow(input);
    expect(easternDate(result)).toBe(easternDate(input));
    expect(easternClock(result)).toBe("09:00");
  });

  it("leaves a mid-afternoon time unchanged during daylight saving too", () => {
    // 2026-07-15 14:00 ET (EDT, UTC-4) = 18:00 UTC
    const input = new Date("2026-07-15T18:00:00.000Z");
    expect(clampToSendWindow(input)).toEqual(input);
  });
});
