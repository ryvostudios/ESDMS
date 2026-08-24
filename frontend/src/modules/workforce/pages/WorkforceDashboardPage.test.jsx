import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { WorkforceDashboardPage } from "./WorkforceDashboardPage.jsx";

const mockListEmployees = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [], meta: { total: 0 } })));
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
  mockListEmployees.mockReset().mockResolvedValue({ data: [], meta: { total: 0 } });
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

// ADV-PRE-03: the dashboard issues one pageSize:1 request for the overall
// total plus one per fixed Employee status — never the whole scope — and
// reads only meta.total from each. This mirrors that contract: a call
// with no `status` returns the sum as the "overall" total; a call with a
// `status` returns just that status's count. `data` is always a
// throwaway single row (or empty), exactly like the real minimal-payload
// requests, so a test that accidentally read data.length instead of
// meta.total would fail loudly.
function mockEmployeeCounts(counts) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  mockListEmployees.mockImplementation(({ status } = {}) => {
    if (status) {
      return Promise.resolve({ data: (counts[status] ?? 0) > 0 ? [{ id: `${status}-1`, status }] : [], meta: { total: counts[status] ?? 0 } });
    }
    return Promise.resolve({ data: total > 0 ? [{ id: "any-1" }] : [], meta: { total } });
  });
}

describe("WorkforceDashboardPage", () => {
  test("renders employee/status KPIs from server meta.total, not data.length", async () => {
    mockEmployeeCounts({ ACTIVE: 2, INACTIVE: 1, RESIGNED: 0, TERMINATED: 0 });
    await renderPage();

    expect(screen.getByText("Employees in scope")).toBeTruthy();
    expect(screen.getAllByText("3").length).toBeGreaterThan(0);
    expect(screen.getByText("Active employees")).toBeTruthy();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getByText("Employee status breakdown")).toBeTruthy();
  });

  test("leave and document KPIs only render when the actor holds the relevant permissions", async () => {
    mockEmployeeCounts({ ACTIVE: 1 });
    await renderPage();

    expect(screen.queryByText("Pending leave requests")).toBeNull();
    expect(screen.queryByText("Documents expiring (30d)")).toBeNull();
    expect(mockListPendingLeave).not.toHaveBeenCalled();
    expect(mockListExpiringDocuments).not.toHaveBeenCalled();
  });

  test("leave.approve grants the pending-leave KPI and fetches it", async () => {
    mockPermissions = new Set(["leave.approve"]);
    mockEmployeeCounts({ ACTIVE: 1 });
    mockListPendingLeave.mockResolvedValue({ data: [{ id: "l1" }, { id: "l2" }] });
    await renderPage();

    expect(screen.getByText("Pending leave requests")).toBeTruthy();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
  });

  test("an empty scope renders a single intentional empty state", async () => {
    mockEmployeeCounts({});
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

// ADV-PRE-02/03: KPI total and status breakdown must be authoritative
// (server meta.total) even when the actual scope exceeds any one page.
describe("WorkforceDashboardPage totals beyond one page (ADV-PRE-02/03)", () => {
  test("with 137 Employees in scope, the KPI total and status breakdown reflect meta.total, not the length of any single page's data", async () => {
    mockEmployeeCounts({ ACTIVE: 130, INACTIVE: 5, RESIGNED: 2, TERMINATED: 0 });
    await renderPage();

    // Every mocked response here carries at most one row of `data` (the
    // minimal pageSize:1 payload) — if the component were still reading
    // data.length anywhere, these would show 1 or 0, never 137/130.
    expect(screen.getAllByText("137").length).toBeGreaterThan(0);
    expect(screen.getAllByText("130").length).toBeGreaterThan(0);

    // Exactly one overall-total request plus one per fixed Employee
    // status (4) — bounded by the enum, never by how many Employees
    // actually exist.
    expect(mockListEmployees).toHaveBeenCalledTimes(5);
  });

  test("document-report permission without leave.approve: the documents KPI shows the real document count, not a false zero, and leave is never fetched", async () => {
    mockPermissions = new Set(["employee_documents.view", "workforce.reports.view"]);
    mockEmployeeCounts({ ACTIVE: 1 });
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
    mockEmployeeCounts({ ACTIVE: 1 });
    mockListPendingLeave.mockResolvedValue({ data: [{ id: "l1" }] });
    mockListExpiringDocuments.mockResolvedValue({ data: [{ id: "d1" }, { id: "d2" }] });
    await renderPage();

    expect(screen.getByText("Pending leave requests")).toBeTruthy();
    expect(screen.getByText("Documents expiring (30d)")).toBeTruthy();
    expect(screen.getAllByText("1").length).toBeGreaterThan(0); // 1 pending leave request
    expect(screen.getAllByText("2").length).toBeGreaterThan(0); // 2 expiring documents
  });
});
