import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { DemandDetailPage } from "./DemandDetailPage.jsx";

const mockUseDemand = vi.hoisted(() => vi.fn());

vi.mock("../hooks/useDemand.js", () => ({
  useDemand: (...args) => mockUseDemand(...args),
}));

vi.mock("../api.js", () => ({
  submitDemand: vi.fn(),
}));

let mockPermissions = new Set();
vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({
    hasPermission: (...codes) => codes.some((code) => mockPermissions.has(code)),
  }),
}));

function baseDemand(overrides = {}) {
  return {
    demand: {
      id: "demand-1",
      demand_number: "DL-2026-000001",
      status: "DRAFT",
      department_name: "Civil",
      site_name: "E-Set — Main Site",
      created_by_name: "Test Team Lead",
      created_at: "2026-08-25T00:00:00.000Z",
      submitted_at: null,
      note: null,
      ...overrides,
    },
    lines: [{ id: "line-1", item_name_snapshot: "Cement", requested_quantity: "50.00", uom_name_snapshot: "Bags" }],
    auditLog: [{ id: "audit-1", action: "CREATE", actorName: "Test Team Lead", createdAt: "2026-08-25T00:00:00.000Z" }],
  };
}

afterEach(() => {
  cleanup();
  mockUseDemand.mockReset();
  mockPermissions = new Set();
});

async function renderPage() {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={["/demands/demand-1"]}>
        <Routes>
          <Route path="/demands/:id" element={<DemandDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

describe("DemandDetailPage", () => {
  test("a DRAFT Demand shows Edit and Submit actions for an authorized actor", async () => {
    mockPermissions = new Set(["demand.edit", "demand.submit"]);
    mockUseDemand.mockReturnValue({ result: baseDemand(), status: "ready", error: null, reload: vi.fn() });

    await renderPage();

    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit for Review" })).toBeTruthy();
    expect(screen.queryByText(/pending management review/i)).toBeNull();
  });

  test("a submitted Demand is read-only and shows the pending-review notice", async () => {
    mockPermissions = new Set(["demand.edit", "demand.submit"]);
    mockUseDemand.mockReturnValue({
      result: baseDemand({ status: "PENDING_INITIAL_REVIEW", submitted_at: "2026-08-25T01:00:00.000Z" }),
      status: "ready",
      error: null,
      reload: vi.fn(),
    });

    await renderPage();

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit for Review" })).toBeNull();
    expect(screen.getByText(/pending management review/i)).toBeTruthy();
  });

  test("a view-only actor never sees Edit or Submit even on a DRAFT Demand", async () => {
    mockPermissions = new Set(); // demand.view only, implicit via route access
    mockUseDemand.mockReturnValue({ result: baseDemand(), status: "ready", error: null, reload: vi.fn() });

    await renderPage();

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit for Review" })).toBeNull();
  });

  test("loading and error states render before the detail is available", async () => {
    mockUseDemand.mockReturnValue({ result: null, status: "loading", error: null, reload: vi.fn() });
    await renderPage();
    expect(screen.getByText(/loading demand/i)).toBeTruthy();

    cleanup();
    mockUseDemand.mockReturnValue({ result: null, status: "error", error: "Network error", reload: vi.fn() });
    await renderPage();
    expect(screen.getByText("Network error")).toBeTruthy();
  });
});
