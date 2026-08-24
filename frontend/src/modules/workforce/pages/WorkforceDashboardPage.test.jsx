import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { WorkforceDashboardPage } from "./WorkforceDashboardPage.jsx";

const mockListEmployees = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [] })));
const mockListPendingLeave = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [] })));
const mockListExpiringDocuments = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [] })));

vi.mock("../api.js", () => ({
  listEmployees: mockListEmployees,
  listPendingLeave: mockListPendingLeave,
  listExpiringDocuments: mockListExpiringDocuments,
}));

let mockPermissions = new Set();
// A stable function reference (not recreated per render) — the component's
// effect depends on hasPermission itself, so a fresh closure every render
// would re-trigger the effect in an infinite loop under this mock.
function hasPermission(...codes) {
  return codes.some((code) => mockPermissions.has(code));
}
vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({ hasPermission }),
}));

afterEach(() => {
  cleanup();
  mockListEmployees.mockReset().mockResolvedValue({ data: [] });
  mockListPendingLeave.mockReset().mockResolvedValue({ data: [] });
  mockListExpiringDocuments.mockReset().mockResolvedValue({ data: [] });
  mockPermissions = new Set();
});

async function renderPage() {
  await act(async () => {
    render(
      <MemoryRouter>
        <WorkforceDashboardPage />
      </MemoryRouter>,
    );
  });
}

describe("WorkforceDashboardPage", () => {
  test("renders employee/status KPIs from real listEmployees data", async () => {
    mockListEmployees.mockResolvedValue({
      data: [
        { id: "1", status: "ACTIVE" },
        { id: "2", status: "ACTIVE" },
        { id: "3", status: "INACTIVE" },
      ],
    });
    await renderPage();

    expect(screen.getByText("Employees in scope")).toBeTruthy();
    expect(screen.getAllByText("3").length).toBeGreaterThan(0);
    expect(screen.getByText("Active employees")).toBeTruthy();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getByText("Employee status breakdown")).toBeTruthy();
  });

  test("leave and document KPIs only render when the actor holds the relevant permissions", async () => {
    mockListEmployees.mockResolvedValue({ data: [{ id: "1", status: "ACTIVE" }] });
    await renderPage();

    expect(screen.queryByText("Pending leave requests")).toBeNull();
    expect(screen.queryByText("Documents expiring (30d)")).toBeNull();
    expect(mockListPendingLeave).not.toHaveBeenCalled();
    expect(mockListExpiringDocuments).not.toHaveBeenCalled();
  });

  test("leave.approve grants the pending-leave KPI and fetches it", async () => {
    mockPermissions = new Set(["leave.approve"]);
    mockListEmployees.mockResolvedValue({ data: [{ id: "1", status: "ACTIVE" }] });
    mockListPendingLeave.mockResolvedValue({ data: [{ id: "l1" }, { id: "l2" }] });
    await renderPage();

    expect(screen.getByText("Pending leave requests")).toBeTruthy();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
  });

  test("an empty scope renders a single intentional empty state", async () => {
    mockListEmployees.mockResolvedValue({ data: [] });
    await renderPage();

    expect(await screen.findByText("No employees yet")).toBeTruthy();
    expect(screen.queryByText("Employee status breakdown")).toBeNull();
  });

  test("a load failure renders the error state", async () => {
    mockListEmployees.mockRejectedValue(new Error("Network error"));
    await renderPage();

    expect(await screen.findByText("Network error")).toBeTruthy();
  });
});
