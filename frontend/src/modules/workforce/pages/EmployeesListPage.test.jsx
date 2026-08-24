import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { EmployeesListPage } from "./EmployeesListPage.jsx";

const mockListEmployees = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [], meta: { page: 1, pageSize: 25, total: 0 } })));
const mockListSites = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [{ id: "s1", name: "Only Site" }] })));
const mockDownloadEmployeeMasterReport = vi.hoisted(() => vi.fn());

vi.mock("../api.js", () => ({
  listEmployees: mockListEmployees,
  listSites: mockListSites,
  downloadEmployeeMasterReport: mockDownloadEmployeeMasterReport,
}));

let mockPermissions = new Set();
function hasPermission(...codes) {
  return codes.some((code) => mockPermissions.has(code));
}
vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({ hasPermission }),
}));

afterEach(() => {
  cleanup();
  mockListEmployees.mockReset().mockResolvedValue({ data: [], meta: { page: 1, pageSize: 25, total: 0 } });
  mockListSites.mockReset().mockResolvedValue({ data: [{ id: "s1", name: "Only Site" }] });
  mockDownloadEmployeeMasterReport.mockReset();
  mockPermissions = new Set();
});

const EMPLOYEE = {
  id: "e1",
  employeeCode: "EMP-1",
  fullLegalName: "Jordan Rivera",
  status: "ACTIVE",
  hasLogin: true,
  positionName: "Site Engineer",
  departmentName: "Operations",
  primarySiteId: "s1",
};

async function renderPage() {
  await act(async () => {
    render(
      <MemoryRouter>
        <EmployeesListPage />
      </MemoryRouter>,
    );
  });
}

describe("EmployeesListPage", () => {
  test("renders an employee's identity, position, department, site and status in both the table and mobile card", async () => {
    mockListEmployees.mockResolvedValue({ data: [EMPLOYEE], meta: { page: 1, pageSize: 25, total: 1 } });
    await renderPage();

    expect(screen.getAllByText("Jordan Rivera").length).toBe(2); // table row + mobile card
    expect(screen.getAllByText("Site Engineer").length).toBe(2);
    expect(screen.getAllByText("Operations").length).toBe(2);
    expect(screen.getAllByText("Only Site").length).toBe(2);
    expect(screen.getAllByText("Active").length).toBe(2);
  });

  test("empty result with no active filter shows the plain 'no employees yet' empty state (Add Employee stays in the header, not duplicated)", async () => {
    mockPermissions = new Set(["employees.create"]);
    await renderPage();

    expect(await screen.findByText("No employees yet")).toBeTruthy();
    // Exactly one Add Employee action exists (the PageHeader's) — the
    // empty state does not render a second, redundant one.
    expect(screen.getAllByRole("link", { name: "Add Employee" }).length).toBe(1);
  });

  test("empty result WITH an active search shows a filter-specific message", async () => {
    await renderPage();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search employees"), { target: { value: "nobody" } });
    });

    expect(await screen.findByText("No employees match these filters")).toBeTruthy();
    expect(screen.getByText("Try a different search term or clear the filters.")).toBeTruthy();
  });

  test("changing the status filter re-fetches with the selected status", async () => {
    mockListEmployees.mockResolvedValue({ data: [EMPLOYEE], meta: { page: 1, pageSize: 25, total: 1 } });
    await renderPage();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Employment status"), { target: { value: "INACTIVE" } });
    });

    expect(mockListEmployees).toHaveBeenCalledWith(expect.objectContaining({ status: "INACTIVE" }));
  });

  test("Add Employee action is hidden without employees.create", async () => {
    await renderPage();
    expect(screen.queryByRole("link", { name: "Add Employee" })).toBeNull();
  });

  test("a Site filter only appears when more than one site is in scope", async () => {
    await renderPage();
    expect(screen.queryByLabelText("Site")).toBeNull();

    mockListSites.mockResolvedValue({
      data: [
        { id: "s1", name: "Site One" },
        { id: "s2", name: "Site Two" },
      ],
    });
    await renderPage();
    expect(await screen.findByLabelText("Site")).toBeTruthy();
  });

  test("a load failure renders the error state", async () => {
    mockListEmployees.mockRejectedValue(new Error("Network error"));
    await renderPage();

    expect(await screen.findByText("Unable to load employees.")).toBeTruthy();
  });
});

// ADV-PRE-02: >100 Employees must all be reachable, not just the first
// page — real server-backed pagination, not a fixed pageSize=100 ceiling.
describe("EmployeesListPage pagination (ADV-PRE-02)", () => {
  function employeesPage(pageNumber, pageSize, total) {
    const start = (pageNumber - 1) * pageSize;
    const count = Math.max(0, Math.min(pageSize, total - start));
    const data = Array.from({ length: count }, (_, i) => ({
      ...EMPLOYEE,
      id: `e-page${pageNumber}-${i}`,
      employeeCode: `EMP-${start + i + 1}`,
      fullLegalName: `Employee ${start + i + 1}`,
    }));
    return { data, meta: { page: pageNumber, pageSize, total } };
  }

  test("page 1 renders, Next requests and renders page 2, Previous returns to page 1", async () => {
    const total = 137;
    mockListEmployees.mockImplementation(({ page = 1, pageSize = 25 }) =>
      Promise.resolve(employeesPage(page, pageSize, total)),
    );
    await renderPage();

    expect((await screen.findAllByText("Employee 1")).length).toBeGreaterThan(0);
    expect(screen.getByText(/1–25 of 137/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
    });

    expect(mockListEmployees).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, pageSize: 25 }));
    expect((await screen.findAllByText("Employee 26")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Employee 1")).toBeNull();
    expect(screen.getByText(/26–50 of 137/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    });

    expect(mockListEmployees).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 25 }));
    expect((await screen.findAllByText("Employee 1")).length).toBeGreaterThan(0);
  });

  test("Previous is disabled on page 1 and Next is disabled on the last page", async () => {
    mockListEmployees.mockImplementation(({ page = 1, pageSize = 25 }) => Promise.resolve(employeesPage(page, pageSize, 137)));
    await renderPage();

    await screen.findAllByText("Employee 1");
    expect(screen.getByRole("button", { name: "Previous" }).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Next" }).disabled).toBe(false);

    // Last page (137 total / 25 per page = page 6, partial).
    mockListEmployees.mockImplementation(({ page = 1, pageSize = 25 }) => Promise.resolve(employeesPage(page, pageSize, 137)));
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
      });
      await screen.findByText(/of 137/);
    }

    expect(mockListEmployees).toHaveBeenLastCalledWith(expect.objectContaining({ page: 6 }));
    expect(screen.getByRole("button", { name: "Next" }).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Previous" }).disabled).toBe(false);
  });

  test("changing search resets pagination to page 1", async () => {
    mockListEmployees.mockImplementation(({ page = 1, pageSize = 25 }) => Promise.resolve(employeesPage(page, pageSize, 137)));
    await renderPage();
    await screen.findAllByText("Employee 1");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
    });
    expect(mockListEmployees).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search employees"), { target: { value: "Jordan" } });
    });

    expect(mockListEmployees).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, search: "Jordan" }));
  });

  test("changing status or site filters also resets pagination to page 1", async () => {
    mockListEmployees.mockImplementation(({ page = 1, pageSize = 25 }) => Promise.resolve(employeesPage(page, pageSize, 137)));
    await renderPage();
    await screen.findAllByText("Employee 1");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
    });
    expect(mockListEmployees).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Employment status"), { target: { value: "INACTIVE" } });
    });
    expect(mockListEmployees).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, status: "INACTIVE" }));
  });

  test("server total is displayed correctly and desktop table / mobile cards render the same page data", async () => {
    mockListEmployees.mockResolvedValue(employeesPage(1, 25, 137));
    await renderPage();

    expect(await screen.findByText(/1–25 of 137/)).toBeTruthy();
    // Table + mobile card both render the same 25-row page — every name
    // appears exactly twice, never once (a stale/second data set) and
    // never zero (dropped).
    expect(screen.getAllByText("Employee 1").length).toBe(2);
    expect(screen.getAllByText("Employee 25").length).toBe(2);
    expect(screen.queryByText("Employee 26")).toBeNull();
  });
});
