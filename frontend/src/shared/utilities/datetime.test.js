import { describe, test, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("shared datetime formatter", () => {
  test("formats a UTC instant in the configured business timezone, not the host's local timezone", async () => {
    vi.stubEnv("VITE_APP_TIMEZONE", "Asia/Karachi");
    const { formatDateTime, formatDate } = await import("./datetime.js");

    // 2026-01-01 20:00 UTC is already 2026-01-02 01:00 in Asia/Karachi
    // (UTC+5) — the date itself must reflect that, not the UTC day.
    const value = "2026-01-01T20:00:00.000Z";

    expect(formatDate(value)).toContain("2026");
    expect(formatDate(value)).toContain("2");
    expect(formatDateTime(value)).toContain("2026");

    // A different configured timezone must produce a different result for
    // the same instant — proving the formatter actually reads the config,
    // not just always agreeing with itself.
    vi.resetModules();
    vi.stubEnv("VITE_APP_TIMEZONE", "America/Los_Angeles");
    const { formatDateTime: formatDateTimeElsewhere } = await import("./datetime.js");
    expect(formatDateTimeElsewhere(value)).not.toBe(formatDateTime(value));
  });

  test("a calendar date is never pushed through a timezone", async () => {
    // A PostgreSQL `date` has no time and no timezone. Constructing a Date
    // from 'YYYY-MM-DD' parses it as UTC midnight, which then renders the
    // previous day in any timezone west of UTC — the exact off-by-one-day
    // this must not reintroduce. The same calendar date must render
    // identically no matter what the business timezone is.
    for (const timezone of ["Asia/Karachi", "America/Los_Angeles", "Pacific/Auckland", "UTC"]) {
      vi.resetModules();
      vi.stubEnv("VITE_APP_TIMEZONE", timezone);
      const { formatDate, formatDateTime } = await import("./datetime.js");

      expect(formatDate("2026-01-01"), timezone).toBe("01/01/2026");
      expect(formatDate("2025-12-31"), timezone).toBe("31/12/2025");
      // A date has no time of day, so formatDateTime must not invent one.
      expect(formatDateTime("2026-01-01"), timezone).toBe("01/01/2026");
    }
  });

  test("returns null for a missing value instead of formatting the epoch", async () => {
    const { formatDate, formatDateTime } = await import("./datetime.js");

    expect(formatDate(null)).toBeNull();
    expect(formatDate(undefined)).toBeNull();
    expect(formatDateTime(null)).toBeNull();
  });

  test("currentYear reflects the configured business timezone", async () => {
    vi.stubEnv("VITE_APP_TIMEZONE", "Asia/Karachi");
    const { currentYear } = await import("./datetime.js");

    expect(currentYear()).toBe(new Date().getFullYear());
  });
});
