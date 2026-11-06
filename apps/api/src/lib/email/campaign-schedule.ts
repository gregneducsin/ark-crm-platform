export interface CampaignSchedule {
  days: number[]; // Sunday = 0
  start: string;
  end: string;
  timezone: string;
}

export function validateCampaignSchedule(
  value: unknown,
): CampaignSchedule | null {
  if (value === null) return null;
  const s = value as CampaignSchedule | undefined;
  if (
    !s ||
    !Array.isArray(s.days) ||
    !s.days.length ||
    s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
  )
    throw new Error("Choose at least one sending day");
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (
    typeof s.start !== "string" ||
    typeof s.end !== "string" ||
    !time.test(s.start) ||
    !time.test(s.end) ||
    s.start >= s.end
  )
    throw new Error("Choose an end time after the start time on the same day");
  if (typeof s.timezone !== "string" || !s.timezone)
    throw new Error("Choose a timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s.timezone }).format();
  } catch {
    throw new Error("Choose a valid timezone");
  }
  return {
    days: [...new Set(s.days)].sort(),
    start: s.start,
    end: s.end,
    timezone: s.timezone,
  };
}

export function campaignWindowOpen(
  schedule: CampaignSchedule | null,
  now = new Date(),
): boolean {
  if (!schedule) return true;
  // Local wall time follows daylight-saving changes; the server timezone is irrelevant.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (name: string) =>
    parts.find((p) => p.type === name)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    part("weekday"),
  );
  const time = `${part("hour")}:${part("minute")}`;
  return (
    schedule.days.includes(day) && time >= schedule.start && time < schedule.end
  );
}
