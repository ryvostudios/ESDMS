import { APP_TIMEZONE } from "../../core/config/env.js";

// Two different kinds of value arrive from the API and must not be treated
// the same way:
//
//   an INSTANT (timestamptz — approval, departure, return, audit) is a real
//   moment in time, and is shown in the business's own timezone so a manager
//   in another region sees the same times gate staff do;
//
//   a CALENDAR DATE (date — joining, effective, expiry, licence expiry,
//   expected return, contract and leave start/end) has no time and no
//   timezone. Feeding 'YYYY-MM-DD' to `new Date` parses it as UTC midnight
//   and then shifts it into APP_TIMEZONE, which renders the wrong day
//   wherever that shift crosses midnight. The backend already stopped
//   converting these through the host timezone (see backend
//   src/config/date-types.js); doing the same here means neither side has a
//   timezone in the path at all.
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function formatDate(value) {
  if (!value) return null;

  if (typeof value === "string" && CALENDAR_DATE.test(value)) {
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  }

  return new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIMEZONE }).format(new Date(value));
}

export function formatDateTime(value) {
  if (!value) return null;

  // A calendar date has no time of day to show, so a time would be invented.
  if (typeof value === "string" && CALENDAR_DATE.test(value)) {
    return formatDate(value);
  }

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function currentYear() {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: APP_TIMEZONE, year: "numeric" }).format(new Date()));
}
