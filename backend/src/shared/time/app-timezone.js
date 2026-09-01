import config from "../../config/env.js";
import { isCalendarDate } from "../../config/date-types.js";

// All timestamps are persisted as UTC/timestamptz. These helpers only
// affect derivation (the gate pass number's year) and display (printed PDF
// dates), keeping both deterministic regardless of the host machine's own
// local timezone.
export function currentYearInAppTimezone(date = new Date()) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: config.appTimezone, year: "numeric" }).format(date));
}

// "en-CA" formats as YYYY-MM-DD, matching the plain date strings (no time
// component) used throughout Workforce for effective/joining/status dates.
export function currentDateInAppTimezone(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: config.appTimezone }).format(date);
}

// A calendar date has no timezone, so it is rendered as-is rather than
// pushed through one. Passing 'YYYY-MM-DD' to `new Date` would parse it as
// UTC midnight and then shift it into appTimezone — the same class of
// off-by-one-day the date type parser exists to prevent.
export function formatDate(value) {
  if (isCalendarDate(value)) {
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  }
  return new Intl.DateTimeFormat("en-GB", { timeZone: config.appTimezone }).format(new Date(value));
}

export function formatDateTime(value) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: config.appTimezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
