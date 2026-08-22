import { APP_TIMEZONE } from "../../core/config/env.js";

// All operational timestamps (approval, departure, return, audit log,
// "today's date") are shown in the business's own timezone, not the
// viewer's device/browser timezone — a manager checking the dashboard
// from a different region must see the same times gate staff do. Backend
// timestamps stay UTC/timestamptz; only display is affected here.
export function formatDate(value) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIMEZONE }).format(new Date(value));
}

export function formatDateTime(value) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function currentYear() {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: APP_TIMEZONE, year: "numeric" }).format(new Date()));
}
