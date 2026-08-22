import { describe, test, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GatePassStatusBadge } from "./GatePassStatusBadge.jsx";

afterEach(cleanup);

describe("GatePassStatusBadge", () => {
  test("renders a human-readable label for a known status", () => {
    render(<GatePassStatusBadge status="PENDING_APPROVAL" />);
    expect(screen.getByText("Pending Approval")).toBeTruthy();
  });

  test("renders VEHICLE_OUTSIDE as its own readable label", () => {
    render(<GatePassStatusBadge status="VEHICLE_OUTSIDE" />);
    expect(screen.getByText("Vehicle Outside")).toBeTruthy();
  });
});
