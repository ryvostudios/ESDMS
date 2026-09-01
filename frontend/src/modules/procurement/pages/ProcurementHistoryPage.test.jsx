import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ProcurementHistoryPage } from "./ProcurementHistoryPage.jsx";

const mockUseIpoList = vi.hoisted(() => vi.fn());
const mockGet = vi.hoisted(() => vi.fn());
const mockGetBlob = vi.hoisted(() => vi.fn());

vi.mock("../../ipo/hooks/useIpoList.js", () => ({ useIpoList: (...args) => mockUseIpoList(...args) }));
vi.mock("../../../core/api/client.js", () => ({
  apiClient: { get: (...args) => mockGet(...args), getBlob: (...args) => mockGetBlob(...args) },
}));
vi.mock("../../../shared/utilities/download.js", () => ({ downloadBlob: vi.fn() }));

const mockHasPermission = vi.hoisted(() => vi.fn());
vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({ hasPermission: (...args) => mockHasPermission(...args) }),
}));

afterEach(() => {
  cleanup();
  mockUseIpoList.mockReset();
  mockGet.mockReset();
  mockGetBlob.mockReset();
  mockHasPermission.mockReset();
});

// The page is offered to anyone who can see IPO history; only the EXPORT
// section needs procurement.export.
function withExportAuthority(allowed = true) {
  mockHasPermission.mockImplementation((code) => code !== "procurement.export" || allowed);
}

const ROWS = [
  {
    id: "ipo-1",
    ipo_number: "ESET/2026/32",
    demand_number: "DL-2026-000004",
    department_name: "Civil",
    status: "COMPLETED",
    generated_at: "2026-08-01T09:00:00.000Z",
    completed_at: "2026-08-10T09:00:00.000Z",
  },
];

function readyList() {
  mockUseIpoList.mockReturnValue({ rows: ROWS, total: 1, status: "ready", error: null, reload: vi.fn() });
}

async function renderPage() {
  await act(async () => {
    render(
      <MemoryRouter>
        <ProcurementHistoryPage />
      </MemoryRouter>,
    );
  });
}

describe("ProcurementHistoryPage", () => {
  test("offers only the export datasets the server says the user may take", async () => {
    readyList();
    withExportAuthority(true);
    mockGet.mockResolvedValue({
      data: [
        { key: "demand-history", name: "Demand History", includesPricing: false },
        { key: "receiving-history", name: "Receiving History", includesPricing: false },
      ],
    });
    await renderPage();

    expect(screen.getByRole("button", { name: "Demand History" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Receiving History" })).toBeTruthy();
    // The commercial dataset was not offered by the catalog, so it is absent.
    expect(screen.queryByRole("button", { name: "Purchasing History" })).toBeNull();
  });

  test("a user without export authority is told why, and no request is made for it", async () => {
    // This page used to fetch the export catalog unconditionally, so a
    // Procurement Staff user (who holds ipo.view but not procurement.export)
    // triggered a guaranteed 403 on every mount, swallowed silently, leaving
    // the page promising an export section it would never render.
    readyList();
    withExportAuthority(false);
    await renderPage();

    expect(mockGet).not.toHaveBeenCalledWith("/reports/procurement/catalog");
    expect(screen.getByRole("heading", { name: /excel exports/i })).toBeTruthy();
    expect(screen.getByText(/procurement\.export capability/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Demand History" })).toBeNull();

    // The history itself is unaffected, which is why the page stays offered.
    expect(screen.getByText("ESET/2026/32")).toBeTruthy();
  });

  test("a genuine catalog failure is surfaced, not mistaken for missing authority", async () => {
    readyList();
    withExportAuthority(true);
    mockGet.mockRejectedValue(new Error("Export catalog unavailable"));
    await renderPage();

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/catalog unavailable/i));
  });

  test("filters are sent to the server as query parameters, not applied in the browser", async () => {
    readyList();
    withExportAuthority(true);
    mockGet.mockResolvedValue({ data: [{ key: "ipo-history", name: "IPO History", includesPricing: true }] });
    mockGetBlob.mockResolvedValue(new Blob(["x"]));
    await renderPage();

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-12-31" } });
    fireEvent.change(screen.getByLabelText("Reference"), { target: { value: "ESET/2026/32" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "IPO History" }));
    });

    await waitFor(() => expect(mockGetBlob).toHaveBeenCalled());
    const requested = mockGetBlob.mock.calls[0][0];
    expect(requested).toContain("/reports/procurement/ipo-history.xlsx?");
    expect(requested).toContain("from=2026-01-01");
    expect(requested).toContain("to=2026-12-31");
    expect(requested).toContain(encodeURIComponent("ESET/2026/32"));
  });

  test("surfaces a refused export instead of failing silently", async () => {
    readyList();
    withExportAuthority(true);
    mockGet.mockResolvedValue({ data: [{ key: "procurement-history", name: "Purchasing History" }] });
    mockGetBlob.mockRejectedValue(new Error("This export contains commercial information you are not authorized to view."));
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Purchasing History" }));
    });
    expect(screen.getByRole("alert").textContent).toMatch(/not authorized/i);
  });

  test("renders loading, empty and error states for the history list", async () => {
    withExportAuthority(true);
    mockGet.mockResolvedValue({ data: [] });
    mockUseIpoList.mockReturnValue({ rows: [], total: 0, status: "loading", error: null, reload: vi.fn() });
    await renderPage();
    expect(screen.getByText(/loading history/i)).toBeTruthy();

    cleanup();
    mockUseIpoList.mockReturnValue({ rows: [], total: 0, status: "ready", error: null, reload: vi.fn() });
    await renderPage();
    expect(screen.getByText("No matching records")).toBeTruthy();

    cleanup();
    mockUseIpoList.mockReturnValue({ rows: [], total: 0, status: "error", error: "History unavailable", reload: vi.fn() });
    await renderPage();
    expect(screen.getByText("History unavailable")).toBeTruthy();
  });
});
