// Covers the Contracts tab after the workforce data-integrity hotfix: a
// contract becomes permanently immutable at finalization, so the draft's
// original terms have to be enterable — and a rejected finalization has to
// be visible rather than silent.
import { describe, test, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { EmployeeDetailPage } from "./EmployeeDetailPage.jsx";
import { ApiError } from "../../../core/api/client.js";

const mockGetEmployee = vi.hoisted(() => vi.fn());
const mockListEmployeeContracts = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [] })));
const mockCreateContractDraft = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: null })));
const mockUpdateContractDraft = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: null })));
const mockUploadContractFile = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: null })));
const mockFinalizeContract = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: null })));

vi.mock("../api.js", () => ({
  getEmployee: mockGetEmployee,
  listEmployeeContracts: mockListEmployeeContracts,
  createContractDraft: mockCreateContractDraft,
  updateContractDraft: mockUpdateContractDraft,
  uploadContractFile: mockUploadContractFile,
  finalizeContract: mockFinalizeContract,
  getContractBlob: vi.fn(),
  // The detail page eagerly loads assignment reference data on mount;
  // stubbed so this file only exercises the Contracts tab.
  getEmployeeAssignments: vi.fn(() => Promise.resolve({ data: [] })),
  listSites: vi.fn(() => Promise.resolve({ data: [] })),
  listDepartments: vi.fn(() => Promise.resolve({ data: [] })),
  listPositions: vi.fn(() => Promise.resolve({ data: [] })),
  listEmploymentTypes: vi.fn(() => Promise.resolve({ data: [] })),
  transferEmployee: vi.fn(() => Promise.resolve({ data: null })),
  changeEmployeeStatus: vi.fn(() => Promise.resolve({ data: null })),
}));

vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

afterEach(() => {
  cleanup();
  mockGetEmployee.mockReset();
  mockListEmployeeContracts.mockReset().mockResolvedValue({ data: [] });
  mockCreateContractDraft.mockReset().mockResolvedValue({ data: null });
  mockUpdateContractDraft.mockReset().mockResolvedValue({ data: null });
  mockUploadContractFile.mockReset().mockResolvedValue({ data: null });
  mockFinalizeContract.mockReset().mockResolvedValue({ data: null });
});

const DRAFT = {
  id: "c1",
  contract_number: "EC-2026-000001",
  kind: "ORIGINAL",
  status: "DRAFT",
  effective_start_date: null,
  terms_summary: null,
  has_file: true,
};

async function renderContracts(contracts = [DRAFT]) {
  mockGetEmployee.mockResolvedValue({
    data: {
      id: "e1",
      fullLegalName: "Test Employee",
      employeeCode: "EMP-1",
      status: "ACTIVE",
      primarySiteId: "s1",
      departmentName: null,
      positionName: null,
      employmentTypeName: null,
      hasLogin: false,
    },
  });
  mockListEmployeeContracts.mockResolvedValue({ data: contracts });
  render(
    <MemoryRouter initialEntries={["/workforce/employees/e1"]}>
      <Routes>
        <Route path="/workforce/employees/:id" element={<EmployeeDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText("Test Employee");
  fireEvent.click(screen.getByRole("button", { name: "Contracts" }));
  await screen.findByText(/EC-2026-000001/);
}

describe("Contracts tab — required draft metadata", () => {
  test("a DRAFT renders controls for the original terms that finalization freezes", async () => {
    await renderContracts();
    expect(screen.getByLabelText(/effective start date/i)).toBeTruthy();
    expect(screen.getByLabelText(/terms summary/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save contract details" })).toBeTruthy();
  });

  test("entered values are saved to the draft", async () => {
    await renderContracts();
    fireEvent.change(screen.getByLabelText(/effective start date/i), { target: { value: "2026-01-15" } });
    fireEvent.change(screen.getByLabelText(/terms summary/i), { target: { value: "Permanent, standard terms." } });
    fireEvent.click(screen.getByRole("button", { name: "Save contract details" }));

    await waitFor(() => expect(mockUpdateContractDraft).toHaveBeenCalledTimes(1));
    expect(mockUpdateContractDraft).toHaveBeenCalledWith("e1", "c1", {
      effectiveStartDate: "2026-01-15",
      termsSummary: "Permanent, standard terms.",
    });
  });

  test("existing draft values are pre-filled rather than silently dropped", async () => {
    await renderContracts([{ ...DRAFT, effective_start_date: "2026-01-15T00:00:00.000Z", terms_summary: "Agreed terms." }]);
    expect(screen.getByLabelText(/effective start date/i).value).toBe("2026-01-15");
    expect(screen.getByLabelText(/terms summary/i).value).toBe("Agreed terms.");
  });

  test("a rejected finalization surfaces the server's reason instead of failing silently", async () => {
    await renderContracts();
    mockFinalizeContract.mockRejectedValue(
      new ApiError(400, "VALIDATION_ERROR", "Set the effective start date before finalizing this contract."),
    );

    fireEvent.click(screen.getByRole("button", { name: /Finalize/ }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/effective start date before finalizing/i);
    // The contract is still a DRAFT — nothing was silently frozen.
    expect(screen.getByText(/EC-2026-000001 \(ORIGINAL\) — DRAFT/)).toBeTruthy();
  });

  test("a save failure is reported too", async () => {
    await renderContracts();
    mockUpdateContractDraft.mockRejectedValue(new ApiError(409, "CONFLICT", "Only a DRAFT contract can be edited."));
    fireEvent.click(screen.getByRole("button", { name: "Save contract details" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/only a draft contract can be edited/i);
  });

  test("a finalized contract exposes no editing controls", async () => {
    await renderContracts([
      { ...DRAFT, status: "CURRENT", effective_start_date: "2026-01-15T00:00:00.000Z", terms_summary: "Agreed terms." },
    ]);
    expect(screen.queryByLabelText(/effective start date/i)).toBeNull();
    expect(screen.queryByLabelText(/terms summary/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Save contract details" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Finalize/ })).toBeNull();
  });
});
