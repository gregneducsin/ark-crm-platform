/**
 * Every timestamp in the dashboard is pinned to Eastern time (the business's
 * own timezone) rather than the viewer's browser locale — staff comparing
 * notes shouldn't see different times for the same event depending on where
 * they're logged in from. `timeZoneName: "short"` is deliberately omitted
 * from the default formatters (EDT/EST) since the dashboard doesn't mix
 * timezones anywhere a viewer could get confused about which one they're
 * reading.
 */
const TIME_ZONE = "America/New_York";

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { timeZone: TIME_ZONE });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: TIME_ZONE });
}
