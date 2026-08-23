import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AddEmployeePage } from "./AddEmployeePage.jsx";
import { ApiError } from "../../../core/api/client.js";

const mockCreateEmployee = vi.fn();
const mockListSites = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [{ id: "site-1", name: "Only Site" }] })));
const mockListDepartments = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [] })));
const mockListPositions = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [] })));

vi.mock("../api.js", () => ({
  createEmployee: (...args) => mockCreateEmployee(...args),
  listSites: mockListSites,
  listDepartments: mockListDepartments,
  listPositions: mockListPositions,
  listEmploymentTypes: () => Promise.resolve({ data: [] }),
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => vi.fn() };
});

afterEach(() => {
  cleanup();
  mockCreateEmployee.mockReset();
  mockListSites.mockReset().mockResolvedValue({ data: [{ id: "site-1", name: "Only Site" }] });
  mockListDepartments.mockReset().mockResolvedValue({ data: [] });
  mockListPositions.mockReset().mockResolvedValue({ data: [] });
});

async function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText(/employee id/i), { target: { value: "EMP-1" } });
  fireEvent.change(screen.getByLabelText(/full legal name/i), { target: { value: "New Person" } });
  fireEvent.change(screen.getByLabelText(/joining date/i), { target: { value: "2026-01-01" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /create employee/i }));
  });
}

function render409(details) {
  mockCreateEmployee.mockRejectedValue(new ApiError(409, "CONFLICT", "Possible duplicate employee record(s) found.", details));
  return render(
    <MemoryRouter>
      <AddEmployeePage />
    </MemoryRouter>,
  );
}

// ESDMS-002: { matches, outsideScopeMatch } contract rendering.
describe("AddEmployeePage duplicate warning (ESDMS-002)", () => {
  test("same-site match renders with authorized detail", async () => {
    render409({
      matches: [{ id: "m1", employee_code: "EMP-EXIST", full_legal_name: "Jane Existing", cnic_match: true }],
      outsideScopeMatch: false,
    });

    await fillAndSubmit();

    expect(screen.getByText(/EMP-EXIST/)).toBeTruthy();
    expect(screen.getByText(/Jane Existing/)).toBeTruthy();
    expect(screen.queryByText(/outside your access scope/i)).toBeNull();
  });

  test("out-of-scope match renders only the generic warning — no identifying detail, no undefined", async () => {
    render409({ matches: [], outsideScopeMatch: true });

    await fillAndSubmit();

    expect(screen.getByText("A possible matching Employee exists outside your access scope.")).toBeTruthy();
    expect(screen.queryByText(/undefined/i)).toBeNull();
  });
});

function renderPage() {
  return render(
    <MemoryRouter>
      <AddEmployeePage />
    </MemoryRouter>,
  );
}

describe("AddEmployeePage site-first selector (ESDMS-035 / PASS1-R04)", () => {
  test("site-scoped actor (single site returned) gets no Site selector, and Department/Position load immediately", async () => {
    await act(async () => renderPage());

    expect(screen.queryByLabelText(/^site/i)).toBeNull();
    expect(mockListDepartments).toHaveBeenCalledWith("site-1");
    expect(mockListPositions).toHaveBeenCalledWith("site-1");
  });

  test("all-site actor: Add Employee shows a Site selector first, and Department/Position are empty/disabled until a site is chosen", async () => {
    mockListSites.mockResolvedValue({
      data: [
        { id: "site-A", name: "Site A" },
        { id: "site-B", name: "Site B" },
      ],
    });

    await act(async () => renderPage());

    expect(screen.getByLabelText(/^site/i)).toBeTruthy();
    expect(mockListDepartments).not.toHaveBeenCalled();
    expect(mockListPositions).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/department/i).disabled).toBe(true);
    expect(screen.getByLabelText(/position/i).disabled).toBe(true);
  });

  test("all-site actor: Department/Position options follow the selected Site", async () => {
    mockListSites.mockResolvedValue({
      data: [
        { id: "site-A", name: "Site A" },
        { id: "site-B", name: "Site B" },
      ],
    });
    mockListDepartments.mockImplementation((siteId) =>
      Promise.resolve({ data: [{ id: `dept-${siteId}`, name: `Dept of ${siteId}` }] }),
    );

    await act(async () => renderPage());
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/^site/i), { target: { value: "site-A" } });
    });

    expect(mockListDepartments).toHaveBeenCalledWith("site-A");
    expect(screen.getByRole("option", { name: "Dept of site-A" })).toBeTruthy();
  });

  test("changing the selected Site clears an incompatible Department/Position selection", async () => {
    mockListSites.mockResolvedValue({
      data: [
        { id: "site-A", name: "Site A" },
        { id: "site-B", name: "Site B" },
      ],
    });
    mockListDepartments.mockImplementation((siteId) =>
      Promise.resolve({ data: [{ id: `dept-${siteId}`, name: `Dept of ${siteId}` }] }),
    );

    await act(async () => renderPage());
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/^site/i), { target: { value: "site-A" } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/department/i), { target: { value: "dept-site-A" } });
    });
    expect(screen.getByLabelText(/department/i).value).toBe("dept-site-A");

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/^site/i), { target: { value: "site-B" } });
    });

    expect(screen.getByLabelText(/department/i).value).toBe("");
    expect(mockListDepartments).toHaveBeenCalledWith("site-B");
  });

  test("correct siteId is sent when creating an Employee", async () => {
    mockCreateEmployee.mockResolvedValue({ data: { id: "emp-1" } });

    await act(async () => renderPage());
    await fillAndSubmit();

    expect(mockCreateEmployee).toHaveBeenCalledWith(expect.objectContaining({ siteId: "site-1" }));
  });
});
