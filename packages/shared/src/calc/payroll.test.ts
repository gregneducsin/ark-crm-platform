import { describe, expect, it } from "vitest";
import { calculateHourlyEarnings, calculateWeeklyTotal } from "./payroll.js";

describe("calculateHourlyEarnings", () => {
  it("multiplies hours by rate", () => {
    expect(calculateHourlyEarnings("40", "25.50")).toBe("1020.00");
  });

  it("handles fractional hours", () => {
    expect(calculateHourlyEarnings("37.25", "20.00")).toBe("745.00");
  });

  it("rounds to 2 decimal places", () => {
    expect(calculateHourlyEarnings("10.5", "20.20")).toBe("212.10");
  });

  it("throws on non-numeric input", () => {
    expect(() => calculateHourlyEarnings("not-a-number", "20.00")).toThrow();
  });
});

describe("calculateWeeklyTotal", () => {
  it("sums hourly earnings only when no commission/bonuses given", () => {
    expect(calculateWeeklyTotal({ hourlyEarnings: "800.00" })).toBe("800.00");
  });

  it("adds commission and bonuses", () => {
    expect(
      calculateWeeklyTotal({
        hourlyEarnings: "800.00",
        commissionAmount: "150.00",
        bonusAmounts: ["50.00", "25.00"],
      }),
    ).toBe("1025.00");
  });
});
