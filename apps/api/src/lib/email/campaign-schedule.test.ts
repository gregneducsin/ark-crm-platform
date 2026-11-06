import { describe, it, expect } from "vitest";
import {
  campaignWindowOpen,
  validateCampaignSchedule,
} from "./campaign-schedule.js";
const s = {
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "17:00",
  timezone: "America/New_York",
};
describe("campaign sending windows", () => {
  it("includes opening time and excludes closing time", () => {
    expect(campaignWindowOpen(s, new Date("2026-11-06T13:59:00Z"))).toBe(false);
    expect(campaignWindowOpen(s, new Date("2026-11-06T14:00:00Z"))).toBe(true);
    expect(campaignWindowOpen(s, new Date("2026-11-06T22:00:00Z"))).toBe(false);
  });
  it("excludes weekends and follows daylight saving", () => {
    expect(campaignWindowOpen(s, new Date("2026-11-07T16:00:00Z"))).toBe(false);
    expect(campaignWindowOpen(s, new Date("2026-07-06T13:00:00Z"))).toBe(true);
    expect(campaignWindowOpen(s, new Date("2026-11-06T13:00:00Z"))).toBe(false);
  });
  it("uses the selected local weekday across UTC midnight", () => {
    expect(
      campaignWindowOpen(
        { ...s, days: [5], start: "18:00", end: "23:00" },
        new Date("2026-11-07T01:00:00Z"),
      ),
    ).toBe(true);
  });
  it("rejects invalid or overnight schedules", () => {
    for (const v of [
      { ...s, days: [] },
      { ...s, days: [7] },
      { ...s, start: "17:00" },
      { ...s, start: "23:00" },
      { ...s, end: "24:00" },
      { ...s, timezone: "fake/zone" },
      undefined,
    ])
      expect(() => validateCampaignSchedule(v)).toThrow();
    expect(validateCampaignSchedule(null)).toBe(null);
    expect(campaignWindowOpen(null)).toBe(true);
  });
});
