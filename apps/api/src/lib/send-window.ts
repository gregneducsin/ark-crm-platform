/**
 * Shared Eastern-time quiet hours for scheduled SMS outreach. Live replies
 * and immediate transactional notifications do not use this schedule.
 */

const SEND_WINDOW_TIMEZONE = "America/New_York";
const SEND_WINDOW_START_HOUR = 9; // 9:00 AM ET
const SEND_WINDOW_END_HOUR = 20; // 8:00 PM ET, exclusive
const HOURS_PER_DAY = 24;

/** The hour (0-23) `date` falls on in America/New_York. */
function easternHour(date: Date): number {
  const raw = Number(new Intl.DateTimeFormat("en-US", { timeZone: SEND_WINDOW_TIMEZONE, hour: "2-digit", hour12: false }).format(date));
  // A known ICU quirk renders midnight as "24" rather than "00" under some
  // hour12:false + en-US combinations — normalize so the window check below
  // can't mistake midnight for the end of an allowed day.
  return raw === HOURS_PER_DAY ? 0 : raw;
}

/**
 * 9:00:00 AM Eastern on the given year/month/day. Correct across the DST
 * boundary: a fixed UTC offset can't be hardcoded year-round, so this
 * guesses standard time (-05:00) first and corrects for daylight time
 * (-04:00) if that guess doesn't actually render as 9am in America/New_York.
 */
function nineAmEasternForYMD(y: string, m: string, d: string): Date {
  let guess = new Date(`${y}-${m}-${d}T${String(SEND_WINDOW_START_HOUR).padStart(2, "0")}:00:00-05:00`);
  const renderedHour = easternHour(guess);
  if (renderedHour !== SEND_WINDOW_START_HOUR) {
    guess = new Date(guess.getTime() - (renderedHour - SEND_WINDOW_START_HOUR) * 60 * 60 * 1000);
  }
  return guess;
}

/** Calendar arithmetic before timezone conversion preserves DST transitions. */
function nineAmEasternOnSameDateAs(date: Date, nextDay = false): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: SEND_WINDOW_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  if (!nextDay) return nineAmEasternForYMD(y, m, d);
  const tomorrow = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + 1));
  return nineAmEasternForYMD(String(tomorrow.getUTCFullYear()), String(tomorrow.getUTCMonth() + 1).padStart(2, "0"), String(tomorrow.getUTCDate()).padStart(2, "0"));
}

/**
 * Leave allowed times unchanged; otherwise defer to the next 9am Eastern.
 */
export function clampToSendWindow(date: Date): Date {
  const hour = easternHour(date);
  if (hour >= SEND_WINDOW_START_HOUR && hour < SEND_WINDOW_END_HOUR) return date;
  return nineAmEasternOnSameDateAs(date, hour >= SEND_WINDOW_END_HOUR);
}

export function isScheduledSmsTime(date = new Date()): boolean {
  return clampToSendWindow(date).getTime() === date.getTime();
}

/** Only thrown before submitting a scheduled message to the provider. */
export class SmsQuietHoursError extends Error {
  constructor() { super("Scheduled SMS deferred until the next allowed send window."); this.name = "SmsQuietHoursError"; }
}

export function assertScheduledSmsTime(): void {
  if (!isScheduledSmsTime()) throw new SmsQuietHoursError();
}

/**
 * 9:00am Eastern on a plain "YYYY-MM-DD" date — used to turn a customer's
 * stated preferred follow-up date
 * into a concrete send time,
 * rather than firing at midnight UTC or whatever hour a naive `new
 * Date(isoDate)` would land on.
 */
export function nineAmEasternOnDate(isoDate: string): Date {
  const [y, m, d] = isoDate.split("-");
  return nineAmEasternForYMD(y, m, d);
}
