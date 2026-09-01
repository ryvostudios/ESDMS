import pg from "pg";

// A PostgreSQL `date` is a calendar date, not an instant. node-postgres
// converts it into a JavaScript Date by default, which forces it through a
// timezone it does not have — specifically the NODE PROCESS's local
// timezone, which `options: -c TimeZone=...` in database.js does not affect
// (that pins the SERVER session, which is what makes CURRENT_DATE correct).
//
// The result was that every calendar date's correctness silently depended on
// the deploy host's TZ. Same row, same database, two backend processes:
//
//   DB value                              joining_date = 2026-01-01
//   host TZ Asia/Karachi  (UTC+5)  ->  API 2025-12-31T19:00:00.000Z  -> 01/01/2026  ok
//   host TZ Pacific/Auckland (UTC+13) -> API 2025-12-31T11:00:00.000Z -> 31/12/2025  WRONG
//
// A host east of APP_TIMEZONE rendered every date a day early. Not broken on
// a UTC container today, which is exactly what made it a latent, undocumented
// deployment constraint rather than a visible bug.
//
// Returning the raw 'YYYY-MM-DD' text removes the ambiguity at the source
// instead of compensating for it: there is no instant to get wrong, and no
// host timezone in the path at all. Affects joining_date, effective_date,
// expiry_date, licence_expiry, expected_return_date, contract start/end,
// leave start/end and temporary assignment start/end.
//
// timestamptz (OID 1184) is deliberately untouched: those ARE instants, and
// converting them to Date is correct.
const DATE_OID = 1082;
const DATE_ARRAY_OID = 1182;

const identity = (value) => value;

// Applied to the pg module itself, so every Pool and Client in this process —
// including the ones scripts create — shares one consistent interpretation.
pg.types.setTypeParser(DATE_OID, identity);
pg.types.setTypeParser(DATE_ARRAY_OID, identity);

// A bare calendar date as PostgreSQL returns it. Anything else (a timestamp
// string, a Date) is an instant and must keep its timezone handling.
export const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(value) {
  return typeof value === "string" && CALENDAR_DATE_PATTERN.test(value);
}
