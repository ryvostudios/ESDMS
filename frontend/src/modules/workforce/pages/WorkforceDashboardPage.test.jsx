import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { WorkforceDashboardPage } from "./WorkforceDashboardPage.jsx";

const mockGetEmployeeStatusSummary = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ data: { total: 0, byStatus: { ACTIVE: 0, INACTIVE: 0, RESIGNED: 0, TERMINATED: 0 } } })),
);
const mockListEmployees = vi.hoisted(() => vi.fn());
const mockListPendingLeave = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [] })));
const mockListExpiringDocuments = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [] })));

vi.mock("../api.js", () => ({
  getEmployeeStatusSummary: mockGetEmployeeStatusSummary,
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
  mockGetEmployeeStatusSummary.mockReset().mockResolvedValue({
    data: { total: 0, byStatus: { ACTIVE: 0, INACTIVE: 0, RESIGNED: 0, TERMINATED: 0 } },
  });
  mockListEmployees.mockReset();
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

// REM-02: total + status counts now come from ONE aggregate response
// (backed by a single-statement DB snapshot), not 5 separate
// listEmployees requests each with its own snapshot.
function mockSummary(byStatus) {
  const filled = { ACTIVE: 0, INACTIVE: 0, RESIGNED: 0, TERMINATED: 0, ...byStatus };
  const total = Object.values(filled).reduce((sum, n) => sum + n, 0);
  mockGetEmployeeStatusSummary.mockResolvedValue({ data: { total, byStatus: filled } });
}

describe("WorkforceDashboardPage", () => {
  test("renders employee/status KPIs from the aggregate response", async () => {
    mockSummary({ ACTIVE: 2, INACTIVE: 1 });
    await renderPage();

    expect(screen.getByText("Employees in scope")).toBeTruthy();
    expect(screen.getAllByText("3").length).toBeGreaterThan(0);
    expect(screen.getByText("Active employees")).toBeTruthy();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getByText("Employee status breakdown")).toBeTruthy();
  });

  test("leave and document KPIs only render when the actor holds the relevant permissions", async () => {
    mockSummary({ ACTIVE: 1 });
    await renderPage();

    expect(screen.queryByText("Pending leave requests")).toBeNull();
    expect(screen.queryByText("Documents expiring (30d)")).toBeNull();
    expect(mockListPendingLeave).not.toHaveBeenCalled();
    expect(mockListExpiringDocuments).not.toHaveBeenCalled();
  });

  test("leave.approve grants the pending-leave KPI and fetches it", async () => {
    mockPermissions = new Set(["leave.approve"]);
    mockSummary({ ACTIVE: 1 });
    mockListPendingLeave.mockResolvedValue({ data: [{ id: "l1" }, { id: "l2" }] });
    await renderPage();

    expect(screen.getByText("Pending leave requests")).toBeTruthy();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
  });

  test("an empty scope renders a single intentional empty state", async () => {
    mockSummary({});
    await renderPage();

    expect(await screen.findByText("No employees yet")).toBeTruthy();
    expect(screen.queryByText("Employee status breakdown")).toBeNull();
  });

  test("a load failure renders the error state", async () => {
    mockGetEmployeeStatusSummary.mockRejectedValue(new Error("Network error"));
    await renderPage();

    expect(await screen.findByText("Network error")).toBeTruthy();
  });
});

// REM-02: KPI total and status breakdown must come from the single
// aggregate request, never from listEmployees / page data.
describe("WorkforceDashboardPage uses the single status-summary aggregate (REM-02)", () => {
  test("calls the aggregate endpoint exactly once, and never calls listEmployees for KPI/status counting", async () => {
    mockSummary({ ACTIVE: 130, INACTIVE: 5, RESIGNED: 2 });
    await renderPage();

    expect(screen.getAllByText("137").length).toBeGreaterThan(0);
    expect(screen.getAllByText("130").length).toBeGreaterThan(0);
    expect(mockGetEmployeeStatusSummary).toHaveBeenCalledTimes(1);
    expect(mockListEmployees).not.toHaveBeenCalled();
  });

  test("document-report permission without leave.approve: the documents KPI shows the real document count, not a false zero, and leave is never fetched", async () => {
    mockPermissions = new Set(["employee_documents.view", "workforce.reports.view"]);
    mockSummary({ ACTIVE: 1 });
    mockListExpiringDocuments.mockResolvedValue({ data: [{ id: "d1" }, { id: "d2" }, { id: "d3" }, { id: "d4" }] });
    await renderPage();

    expect(screen.getByText("Documents expiring (30d)")).toBeTruthy();
    expect(screen.getAllByText("4").length).toBeGreaterThan(0);
    expect(screen.queryByText("Pending leave requests")).toBeNull();
    expect(mockListPendingLeave).not.toHaveBeenCalled();
    expect(mockListExpiringDocuments).toHaveBeenCalledTimes(1);
  });

  test("leave.approve AND document-report both granted: each KPI gets its own response, never swapped", async () => {
    mockPermissions = new Set(["leave.approve", "employee_documents.view", "workforce.reports.view"]);
    mockSummary({ ACTIVE: 1 });
    mockListPendingLeave.mockResolvedValue({ data: [{ id: "l1" }] });
    mockListExpiringDocuments.mockResolvedValue({ data: [{ id: "d1" }, { id: "d2" }] });
    await renderPage();

    expect(screen.getByText("Pending leave requests")).toBeTruthy();
    expect(screen.getByText("Documents expiring (30d)")).toBeTruthy();
    expect(screen.getAllByText("1").length).toBeGreaterThan(0); // 1 pending leave request
    expect(screen.getAllByText("2").length).toBeGreaterThan(0); // 2 expiring documents
  });

  test("no request/render loop: the aggregate and permission-gated requests fire exactly once each per mount", async () => {
    mockPermissions = new Set(["leave.approve", "employee_documents.view", "workforce.reports.view"]);
    mockSummary({ ACTIVE: 1 });
    await renderPage();

    expect(mockGetEmployeeStatusSummary).toHaveBeenCalledTimes(1);
    expect(mockListPendingLeave).toHaveBeenCalledTimes(1);
    expect(mockListExpiringDocuments).toHaveBeenCalledTimes(1);
  });
});
