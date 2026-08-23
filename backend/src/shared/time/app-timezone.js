import config from "../../config/env.js";

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

export function formatDate(value) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: config.appTimezone }).format(new Date(value));
}

export function formatDateTime(value) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: config.appTimezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
