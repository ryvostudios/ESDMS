import { test } from "node:test";
import assert from "node:assert/strict";
import { currentYearInAppTimezone } from "../src/shared/time/app-timezone.js";

test("currentYearInAppTimezone uses APP_TIMEZONE, not the host process's local timezone", () => {
  // 2026-12-31 20:00 UTC is already 2027-01-01 01:00 in Asia/Karachi
  // (UTC+5) — a host running in UTC must still number it as 2027.
  const lateUtcNewYearsEve = new Date("2026-12-31T20:00:00Z");
  assert.equal(currentYearInAppTimezone(lateUtcNewYearsEve), 2027);

  // And a moment that's still 2026 everywhere relevant stays 2026.
  const midYear = new Date("2026-06-15T12:00:00Z");
  assert.equal(currentYearInAppTimezone(midYear), 2026);
});
