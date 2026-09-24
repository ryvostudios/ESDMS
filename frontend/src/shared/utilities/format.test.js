import { describe, expect, test } from "vitest";
import { formatEnumLabel } from "./format.js";

describe("formatEnumLabel", () => {
  test("converts an UPPER_SNAKE_CASE enum value to Title Case words", () => {
    expect(formatEnumLabel("PENDING_APPROVAL")).toBe("Pending Approval");
    expect(formatEnumLabel("VEHICLE_OUTSIDE")).toBe("Vehicle Outside");
    expect(formatEnumLabel("DRAFT")).toBe("Draft");
  });

  test("returns an empty string for a missing value", () => {
    expect(formatEnumLabel(undefined)).toBe("");
    expect(formatEnumLabel("")).toBe("");
  });

  test("uses unambiguous application authority labels", () => {
    expect(formatEnumLabel("ADMIN")).toBe("Site Administrator");
    expect(formatEnumLabel("CEO")).toBe("CEO");
    expect(formatEnumLabel("TEAM_LEAD")).toBe("Team Lead");
    // Display only: the role code itself stays GATE_GUARD.
    expect(formatEnumLabel("GATE_GUARD")).toBe("Gate Keeper");
  });
});
