import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { GuardActionPage } from "./GuardActionPage.jsx";

const mockGetGuardGatePass = vi.fn();
vi.mock("../api.js", () => ({
  getGuardGatePass: (...args) => mockGetGuardGatePass(...args),
}));

afterEach(() => {
  cleanup();
  mockGetGuardGatePass.mockReset();
});

function renderAt(id, navigationGatePass) {
  return render(
    <MemoryRouter
      initialEntries={[{ pathname: `/guard/gate-passes/${id}`, state: navigationGatePass ? { gatePass: navigationGatePass } : undefined }]}
    >
      <Routes>
        <Route path="/guard/gate-passes/:id" element={<GuardActionPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("GuardActionPage always refetches authoritative state", () => {
  test("fetches from the server even when navigation state already has the row", async () => {
    let resolveFetch;
    mockGetGuardGatePass.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    renderAt("gp-1", { id: "gp-1", gatePassNumber: "ESD-2026-000001", status: "APPROVED" });

    expect(mockGetGuardGatePass).toHaveBeenCalledWith("gp-1");
    // While unconfirmed, no action form/button must be present — only a
    // confirming/loading indicator naming the pass from nav state.
    expect(screen.getByText(/Confirming ESD-2026-000001/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /confirm exit|confirm return/i })).toBeNull();

    await act(async () => {
      resolveFetch({ data: { id: "gp-1", gatePassNumber: "ESD-2026-000001", status: "APPROVED" } });
    });

    await waitFor(() => expect(screen.queryByText(/Confirming/)).toBeNull());
  });

  test("if the authoritative state differs from navigation state (e.g. already exited by another Guard), the page reflects the server's answer", async () => {
    mockGetGuardGatePass.mockResolvedValue({
      data: { id: "gp-1", gatePassNumber: "ESD-2026-000001", status: "VEHICLE_OUTSIDE" },
    });

    renderAt("gp-1", { id: "gp-1", gatePassNumber: "ESD-2026-000001", status: "APPROVED" });

    await waitFor(() => expect(screen.queryByText(/Confirming/)).toBeNull());
    // VEHICLE_OUTSIDE (server truth) offers RETURN, not EXIT (stale nav
    // state) — proving the rendered action reflects the fetch, not the
    // optimistic skeleton.
    expect(screen.getByRole("button", { name: /complete return/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /confirm exit/i })).toBeNull();
  });
});
