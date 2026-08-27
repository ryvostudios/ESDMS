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

afterEach(() => {
  cleanup();
  mockUseIpoList.mockReset();
  mockGet.mockReset();
  mockGetBlob.mockReset();
});

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

  test("a user with no export authority sees no export section at all", async () => {
    readyList();
    mockGet.mockRejectedValue(new Error("Forbidden"));
    await renderPage();
    expect(screen.queryByRole("heading", { name: /excel exports/i })).toBeNull();
    // History browsing itself still works.
    expect(screen.getByText("ESET/2026/32")).toBeTruthy();
  });

  test("filters are sent to the server as query parameters, not applied in the browser", async () => {
    readyList();
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
    mockGet.mockResolvedValue({ data: [{ key: "procurement-history", name: "Purchasing History" }] });
    mockGetBlob.mockRejectedValue(new Error("This export contains commercial information you are not authorized to view."));
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Purchasing History" }));
    });
    expect(screen.getByRole("alert").textContent).toMatch(/not authorized/i);
  });

  test("renders loading, empty and error states for the history list", async () => {
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
