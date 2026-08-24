import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { EmployeesListPage } from "./EmployeesListPage.jsx";

const mockListEmployees = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [] })));
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
  mockListEmployees.mockReset().mockResolvedValue({ data: [] });
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
    mockListEmployees.mockResolvedValue({ data: [EMPLOYEE] });
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
    mockListEmployees.mockResolvedValue({ data: [EMPLOYEE] });
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
