import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { EmployeeDetailPage } from "./EmployeeDetailPage.jsx";
import { ApiError } from "../../../core/api/client.js";

const mockGetEmployee = vi.fn();
const mockChangeEmployeeStatus = vi.fn();
const mockGetEmployeeAssignments = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [] })));
const mockListSites = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [{ id: "s1", name: "Only Site" }] })));
const mockListDepartments = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [] })));
const mockListPositions = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [] })));
const mockListEmploymentTypes = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [] })));
const mockTransferEmployee = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: null })));
vi.mock("../api.js", () => ({
  getEmployee: (...args) => mockGetEmployee(...args),
  changeEmployeeStatus: (...args) => mockChangeEmployeeStatus(...args),
  getEmployeeAssignments: mockGetEmployeeAssignments,
  listSites: mockListSites,
  listDepartments: mockListDepartments,
  listPositions: mockListPositions,
  listEmploymentTypes: mockListEmploymentTypes,
  transferEmployee: mockTransferEmployee,
}));

vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

afterEach(() => {
  cleanup();
  mockGetEmployee.mockReset();
  mockChangeEmployeeStatus.mockReset();
  mockGetEmployeeAssignments.mockReset().mockResolvedValue({ data: [] });
  mockListSites.mockReset().mockResolvedValue({ data: [{ id: "s1", name: "Only Site" }] });
  mockListDepartments.mockReset().mockResolvedValue({ data: [] });
  mockListPositions.mockReset().mockResolvedValue({ data: [] });
  mockListEmploymentTypes.mockReset().mockResolvedValue({ data: [] });
  mockTransferEmployee.mockReset().mockResolvedValue({ data: null });
});

function employee(status) {
  return {
    id: "e1",
    fullLegalName: "Test Employee",
    employeeCode: "EMP-1",
    status,
    primarySiteId: "s1",
    departmentName: null,
    positionName: null,
    employmentTypeName: null,
    hasLogin: false,
  };
}

async function renderWithStatus(status) {
  mockGetEmployee.mockResolvedValue({ data: employee(status) });
  render(
    <MemoryRouter initialEntries={["/workforce/employees/e1"]}>
      <Routes>
        <Route path="/workforce/employees/:id" element={<EmployeeDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText("Test Employee");
}

function statusSection() {
  return screen.getByRole("heading", { name: "Status", level: 3 }).parentElement;
}

describe("EmployeeDetailPage status transitions (PASS1-R02)", () => {
  test("ACTIVE shows only valid outgoing transitions", async () => {
    await renderWithStatus("ACTIVE");
    const section = within(statusSection());
    expect(section.getByRole("button", { name: "INACTIVE" })).toBeTruthy();
    expect(section.getByRole("button", { name: "RESIGNED" })).toBeTruthy();
    expect(section.getByRole("button", { name: "TERMINATED" })).toBeTruthy();
    expect(section.queryByRole("button", { name: "ACTIVE" })).toBeNull();
  });

  test("INACTIVE shows only ACTIVE", async () => {
    await renderWithStatus("INACTIVE");
    const section = within(statusSection());
    expect(section.getByRole("button", { name: "ACTIVE" })).toBeTruthy();
    expect(section.queryByRole("button", { name: "INACTIVE" })).toBeNull();
    expect(section.queryByRole("button", { name: "RESIGNED" })).toBeNull();
    expect(section.queryByRole("button", { name: "TERMINATED" })).toBeNull();
  });

  test("RESIGNED and TERMINATED never offer a way back to ACTIVE", async () => {
    await renderWithStatus("RESIGNED");
    expect(within(statusSection()).queryByRole("button")).toBeNull();
    cleanup();

    await renderWithStatus("TERMINATED");
    expect(within(statusSection()).queryByRole("button")).toBeNull();
  });

  test("RESIGNED requires a non-empty reason before submitting", async () => {
    await renderWithStatus("ACTIVE");
    fireEvent.click(within(statusSection()).getByRole("button", { name: "RESIGNED" }));

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(screen.getByText("A reason is required.")).toBeTruthy();
    expect(mockChangeEmployeeStatus).not.toHaveBeenCalled();
  });

  test("TERMINATED requires a non-empty reason before submitting", async () => {
    await renderWithStatus("ACTIVE");
    fireEvent.click(within(statusSection()).getByRole("button", { name: "TERMINATED" }));

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(screen.getByText("A reason is required.")).toBeTruthy();
    expect(mockChangeEmployeeStatus).not.toHaveBeenCalled();
  });

  test("submits { status, reason } for a permanent offboarding transition", async () => {
    mockChangeEmployeeStatus.mockResolvedValue({ data: {} });
    await renderWithStatus("ACTIVE");
    fireEvent.click(within(statusSection()).getByRole("button", { name: "RESIGNED" }));

    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "Resigned voluntarily" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });

    expect(mockChangeEmployeeStatus).toHaveBeenCalledWith("e1", { status: "RESIGNED", reason: "Resigned voluntarily" });
  });

  test("a Governance-instruction backend error stays visible and the dialog stays open", async () => {
    mockChangeEmployeeStatus.mockRejectedValue(
      new ApiError(403, "FORBIDDEN", "The linked application account holds a privileged role and is still active. Deactivate it through Governance before offboarding this Employee."),
    );
    await renderWithStatus("ACTIVE");
    fireEvent.click(within(statusSection()).getByRole("button", { name: "TERMINATED" }));
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "Contract ended" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });

    expect(screen.getByRole("alert").textContent).toMatch(/deactivate it through governance/i);
    expect(screen.getByLabelText(/reason/i)).toBeTruthy(); // dialog is still open
  });

  test("success refreshes the Employee record", async () => {
    mockChangeEmployeeStatus.mockResolvedValue({ data: {} });
    await renderWithStatus("ACTIVE");
    expect(mockGetEmployee).toHaveBeenCalledTimes(1);

    fireEvent.click(within(statusSection()).getByRole("button", { name: "RESIGNED" }));
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "Resigned voluntarily" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });

    expect(mockGetEmployee).toHaveBeenCalledTimes(2);
  });
});

async function openAssignmentsTab() {
  fireEvent.click(screen.getByRole("button", { name: "Assignments" }));
  await screen.findByText("Assignment history");
}

describe("EmployeeDetailPage transfer: target-site / active-catalog consistency", () => {
  test("site-scoped actor (single site returned) gets no Site selector, and Department/Position load from that site immediately", async () => {
    await renderWithStatus("ACTIVE");
    await openAssignmentsTab();

    expect(screen.queryByLabelText(/^site/i)).toBeNull();
    expect(mockListDepartments).toHaveBeenCalledWith("s1");
    expect(mockListPositions).toHaveBeenCalledWith("s1");
  });

  test("all-site actor sees a Site selector, and Department/Position options come only from the selected Site", async () => {
    mockListSites.mockResolvedValue({
      data: [
        { id: "s1", name: "Site One" },
        { id: "s2", name: "Site Two" },
      ],
    });
    mockListDepartments.mockImplementation((siteId) =>
      Promise.resolve({ data: [{ id: `dept-${siteId}`, name: `Dept of ${siteId}` }] }),
    );
    mockListPositions.mockImplementation((siteId) =>
      Promise.resolve({ data: [{ id: `pos-${siteId}`, name: `Pos of ${siteId}` }] }),
    );

    await renderWithStatus("ACTIVE");
    await openAssignmentsTab();

    expect(screen.getByLabelText(/^site/i)).toBeTruthy();
    // Defaults to the employee's current site (s1).
    expect(mockListDepartments).toHaveBeenCalledWith("s1");
    expect(screen.getByRole("option", { name: "Dept of s1" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Pos of s1" })).toBeTruthy();

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/^site/i), { target: { value: "s2" } });
    });

    expect(mockListDepartments).toHaveBeenCalledWith("s2");
    expect(mockListPositions).toHaveBeenCalledWith("s2");
    expect(screen.getByRole("option", { name: "Dept of s2" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Pos of s2" })).toBeTruthy();
    // The now-invalid s1 option is gone, not merely appended to.
    expect(screen.queryByRole("option", { name: "Dept of s1" })).toBeNull();
  });

  test("changing target Site clears the selected Department and Position", async () => {
    mockListSites.mockResolvedValue({
      data: [
        { id: "s1", name: "Site One" },
        { id: "s2", name: "Site Two" },
      ],
    });
    mockListDepartments.mockImplementation((siteId) =>
      Promise.resolve({ data: [{ id: `dept-${siteId}`, name: `Dept of ${siteId}` }] }),
    );

    await renderWithStatus("ACTIVE");
    await openAssignmentsTab();

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/department/i), { target: { value: "dept-s1" } });
    });
    expect(screen.getByLabelText(/department/i).value).toBe("dept-s1");

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/^site/i), { target: { value: "s2" } });
    });

    expect(screen.getByLabelText(/department/i).value).toBe("");
    expect(screen.getByLabelText(/position/i).value).toBe("");
  });

  test("Department/Position options are rendered as-is from the active selector, without a stale is_active filter hiding them", async () => {
    // The active-catalog endpoint never returns an is_active column (every
    // row it returns is already active) — a leftover `.filter(is_active)`
    // would silently hide every option.
    mockListDepartments.mockResolvedValue({ data: [{ id: "d1", name: "Engineering" }] });
    mockListPositions.mockResolvedValue({ data: [{ id: "p1", name: "Engineer" }] });

    await renderWithStatus("ACTIVE");
    await openAssignmentsTab();

    expect(await screen.findByRole("option", { name: "Engineering" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Engineer" })).toBeTruthy();
  });

  test("submitted transfer payload contains the intended target site", async () => {
    mockListSites.mockResolvedValue({
      data: [
        { id: "s1", name: "Site One" },
        { id: "s2", name: "Site Two" },
      ],
    });

    await renderWithStatus("ACTIVE");
    await openAssignmentsTab();

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/^site/i), { target: { value: "s2" } });
    });
    fireEvent.change(screen.getByLabelText(/effective date/i), { target: { value: "2026-01-01" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /record assignment/i }));
    });

    expect(mockTransferEmployee).toHaveBeenCalledWith("e1", expect.objectContaining({ siteId: "s2" }));
  });

  test("existing intra-site transfer remains functional (single-site actor, no site change)", async () => {
    await renderWithStatus("ACTIVE");
    await openAssignmentsTab();

    fireEvent.change(screen.getByLabelText(/effective date/i), { target: { value: "2026-01-01" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /record assignment/i }));
    });

    expect(mockTransferEmployee).toHaveBeenCalledWith("e1", expect.objectContaining({ siteId: "s1" }));
    expect(await screen.findByText("Assignment recorded.")).toBeTruthy();
  });
});
