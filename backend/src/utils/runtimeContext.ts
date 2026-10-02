import type { RuntimeContextInput } from "../provider/schemas.js";

/**
 * Build the server-authored system message that gives the model the backend's
 * authoritative current instant plus the user's timezone/locale.
 *
 * The instant always comes from the backend clock (`now`, defaulting to
 * `new Date()` per request). A client can never supply or forge "now"; it only
 * provides presentation metadata (IANA timezone + locale) that the backend
 * uses to derive the user's local date/time, offset and weekday.
 *
 * Two shapes:
 * - `runtimeContext` present and valid → the full six-field message.
 * - `runtimeContext` absent/blank → a UTC-only message that explicitly states
 *   the user's local timezone and local date/time are unavailable, so the model
 *   never mistakes the UTC instant for the user's local time.
 *
 * `now` is injectable so tests are deterministic against a fixed instant.
 */
export function buildRuntimeContextMessage(
  runtimeContext: RuntimeContextInput,
  now: Date = new Date(),
): { role: "system"; content: string } {
  const utcTimestamp = now.toISOString();

  if (!runtimeContext || !runtimeContext.timeZone || !runtimeContext.locale) {
    const content = [
      "Current runtime context:",
      `- UTC timestamp: ${utcTimestamp}`,
      "User local timezone and local date/time are unavailable.",
    ].join("\n");

    return { role: "system", content };
  }

  const { timeZone, locale } = runtimeContext;

  const localDateTime = formatLocalDateTime(timeZone, now);
  const weekday = formatWeekday(timeZone, now);
  const offset = formatUtcOffset(getUtcOffsetMinutes(timeZone, now));

  const content = [
    "Current runtime context:",
    `- UTC timestamp: ${utcTimestamp}`,
    `- User local date/time: ${localDateTime}`,
    `- User timezone: ${timeZone}`,
    `- UTC offset: ${offset}`,
    `- Weekday: ${weekday}`,
    `- User locale: ${locale}`,
  ].join("\n");

  return { role: "system", content };
}

/**
 * Format a `Date` as `YYYY-MM-DD HH:MM:SS` in the given timezone, e.g.
 * `2026-09-29 18:38:00`. Always uses two-digit fields so the shape is stable.
 */
function formatLocalDateTime(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/**
 * Weekday in English (stable regardless of the user's locale) for the date as
 * seen in the user's timezone — a moment near midnight can fall on different
 * calendar days in different timezones.
 */
function formatWeekday(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
  }).format(now);
}

/**
 * Format a UTC offset in minutes as `±HH:MM`, e.g. `-03:00` or `+05:45`.
 */
function formatUtcOffset(totalMinutes: number): string {
  const sign = totalMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(totalMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

/**
 * Compute the UTC offset (in minutes) for a timezone at a specific instant,
 * DST-aware. Derived purely from the runtime's `Intl` implementation — never
 * from the timezone name.
 *
 * The local wall-clock Y/M/D/h/m parts are interpreted as a UTC instant and
 * compared against the real instant, so the calendar-day rollover of zones
 * east of +12:00 (e.g. Pacific/Kiritimati at +14:00) is accounted for. Both
 * instants are truncated to the minute so the subtraction is exact, and the
 * true offset is returned without folding into a ±12:00 window.
 */
function getUtcOffsetMinutes(timeZone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);

  const num = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  const localAsUtc = Date.UTC(num("year"), num("month") - 1, num("day"), num("hour"), num("minute"));
  const nowMinute = Math.floor(now.getTime() / 60_000) * 60_000;
  return Math.round((localAsUtc - nowMinute) / 60_000);
}
