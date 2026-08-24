import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DashboardPage } from "./DashboardPage.jsx";

const mockListGatePasses = vi.hoisted(() => vi.fn());

vi.mock("../api.js", () => ({
  listGatePasses: (...args) => mockListGatePasses(...args),
}));

let mockPermissions = new Set();
vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({
    user: { fullName: "Jordan Rivera" },
    hasPermission: (...codes) => codes.some((code) => mockPermissions.has(code)),
  }),
}));

function mockCounts(counts, recent = []) {
  mockListGatePasses.mockImplementation((filters) => {
    if (filters.status) {
      return Promise.resolve({ data: [], meta: { total: counts[filters.status] ?? 0 } });
    }
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    return Promise.resolve({ data: recent, meta: { total } });
  });
}

afterEach(() => {
  cleanup();
  mockListGatePasses.mockReset();
  mockPermissions = new Set();
});

async function renderPage() {
  await act(async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
  });
}

describe("Gate Pass DashboardPage", () => {
  test("renders KPI counts and status distribution from real per-status totals", async () => {
    mockCounts({
      DRAFT: 1,
      PENDING_APPROVAL: 3,
      APPROVED: 0,
      VEHICLE_OUTSIDE: 2,
      COMPLETED: 5,
      REJECTED: 0,
      CANCELLED: 0,
    });
    await renderPage();

    expect(screen.getByText("11")).toBeTruthy(); // total in scope
    expect(screen.getByText("Pending approval")).toBeTruthy();
    expect(screen.getAllByText("3").length).toBeGreaterThan(0); // KPI value + bar value
    expect(screen.getByText("Vehicles outside")).toBeTruthy();
    expect(screen.getByText("Status distribution")).toBeTruthy();
  });

  test("an actor without gate_pass.approve does not see the pending-approval section", async () => {
    mockCounts({ DRAFT: 1, PENDING_APPROVAL: 0, APPROVED: 0, VEHICLE_OUTSIDE: 0, COMPLETED: 0, REJECTED: 0, CANCELLED: 0 });
    await renderPage();

    expect(screen.queryByText("Pending your approval")).toBeNull();
  });

  test("an actor with gate_pass.approve sees the pending-approval section", async () => {
    mockPermissions = new Set(["gate_pass.approve"]);
    mockCounts({ DRAFT: 0, PENDING_APPROVAL: 1, APPROVED: 0, VEHICLE_OUTSIDE: 0, COMPLETED: 0, REJECTED: 0, CANCELLED: 0 });
    await renderPage();

    expect(await screen.findByText("Pending your approval")).toBeTruthy();
  });

  test("an empty scope (zero Gate Passes) renders a single intentional empty state, not a KPI grid", async () => {
    mockCounts({ DRAFT: 0, PENDING_APPROVAL: 0, APPROVED: 0, VEHICLE_OUTSIDE: 0, COMPLETED: 0, REJECTED: 0, CANCELLED: 0 });
    await renderPage();

    expect(await screen.findByText("No Gate Passes yet")).toBeTruthy();
    expect(screen.queryByText("Status distribution")).toBeNull();
  });

  test("a load failure renders the error state", async () => {
    mockListGatePasses.mockRejectedValue(new Error("Network error"));
    await renderPage();

    expect(await screen.findByText("Network error")).toBeTruthy();
  });
});
