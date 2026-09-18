/**
 * Guardrail against the intake-link follow-up sequence landing at an
 * inconvenient hour — e.g. a lead who clicks their signup link at 11pm
 * Eastern getting the "still there?" nudge at 1am. Only the intake-link
 * follow-up chain uses this (see intake-links.service.ts and
 * follow-up-jobs.service.ts) — every other automated send (abandoned-cart
 * opener, lead check-in, objection re-engagement, review request) keeps its
 * existing timing.
 */

const SEND_WINDOW_TIMEZONE = "America/New_York";
const SEND_WINDOW_START_HOUR = 9; // 9:00 AM ET
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
 * 9:00:00 AM Eastern on the same calendar date (in Eastern) that `date`
 * falls on. Correct across the DST boundary: a fixed UTC offset can't be
 * hardcoded year-round, so this guesses standard time (-05:00) first and
 * corrects for daylight time (-04:00) if that guess doesn't actually render
 * as 9am in America/New_York.
 */
function nineAmEasternOnSameDateAs(date: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: SEND_WINDOW_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;

  let guess = new Date(`${y}-${m}-${d}T${String(SEND_WINDOW_START_HOUR).padStart(2, "0")}:00:00-05:00`);
  const renderedHour = easternHour(guess);
  if (renderedHour !== SEND_WINDOW_START_HOUR) {
    guess = new Date(guess.getTime() - (renderedHour - SEND_WINDOW_START_HOUR) * 60 * 60 * 1000);
  }
  return guess;
}

/**
 * If `date` falls within the 9:00am-11:59pm Eastern window, returns it
 * unchanged. Otherwise (midnight through 8:59am ET), snaps it forward to
 * exactly 9:00am Eastern on that same calendar date — never pushes a date
 * already in the window later, and never pushes a quiet-hours date to the
 * NEXT day, just forward to that morning.
 */
export function clampToSendWindow(date: Date): Date {
  const hour = easternHour(date);
  if (hour >= SEND_WINDOW_START_HOUR) return date;
  return nineAmEasternOnSameDateAs(date);
}
