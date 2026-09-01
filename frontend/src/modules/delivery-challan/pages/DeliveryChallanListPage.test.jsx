import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DeliveryChallanListPage } from "./DeliveryChallanListPage.jsx";

// A Delivery Challan was only reachable by navigating into its IPO, so
// "which challans are open right now?" could not be answered without walking
// IPO by IPO — even though the backend has always had this list endpoint.

const mockList = vi.hoisted(() => vi.fn());
vi.mock("../api.js", () => ({ listDeliveryChallans: (...args) => mockList(...args) }));

afterEach(() => {
  cleanup();
  mockList.mockReset();
});

const ROWS = [
  {
    id: "dc-1",
    dc_number: "ESET-DC/2026/1",
    ipo_number: "ESET/2026/1",
    department_name: "Civil",
    status: "FINALIZED",
    line_count: 3,
    created_at: "2026-08-01T09:00:00.000Z",
  },
];

function ready(rows = ROWS, total = rows.length) {
  mockList.mockResolvedValue({ data: rows, meta: { total } });
}

async function renderPage() {
  await act(async () => {
    render(
      <MemoryRouter>
        <DeliveryChallanListPage />
      </MemoryRouter>,
    );
  });
}

describe("DeliveryChallanListPage", () => {
  test("lists challans with the status and IPO each belongs to", async () => {
    ready();
    await renderPage();

    const row = screen.getByRole("link", { name: /ESET-DC\/2026\/1/ });
    expect(row.textContent).toContain("ESET-DC/2026/1");
    expect(row.textContent).toContain("Civil · IPO ESET/2026/1");
    // Scoped to the row: "FINALIZED" is also one of the filter options.
    expect(row.textContent).toContain("FINALIZED");
    expect(row.textContent).toContain("3 lines");
  });

  test("each row links to its own challan, not to the IPO it came from", async () => {
    ready();
    await renderPage();

    const link = screen.getByRole("link", { name: /ESET-DC\/2026\/1/ });
    expect(link.getAttribute("href")).toBe("/delivery-challans/dc-1");
  });

  test("search and status are sent to the server, not filtered in the browser", async () => {
    ready();
    await renderPage();

    fireEvent.change(screen.getByLabelText("Search Delivery Challans"), {
      target: { value: "ESET-DC/2026/1" },
    });
    await act(async () => {
      // The search input is debounced.
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    await waitFor(() =>
      expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ search: "ESET-DC/2026/1" })),
    );

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Status"), { target: { value: "RECEIVING" } });
    });
    await waitFor(() => expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ status: "RECEIVING" })));
  });

  test("renders loading, empty and error states", async () => {
    mockList.mockReturnValue(new Promise(() => {}));
    await renderPage();
    expect(screen.getByText(/loading delivery challans/i)).toBeTruthy();

    cleanup();
    ready([], 0);
    await renderPage();
    expect(screen.getByText("No Delivery Challans")).toBeTruthy();

    cleanup();
    mockList.mockRejectedValue(new Error("Challans unavailable"));
    await renderPage();
    expect(screen.getByText("Challans unavailable")).toBeTruthy();
  });

  test("a single-line challan is described in the singular", async () => {
    ready([{ ...ROWS[0], line_count: 1 }]);
    await renderPage();
    expect(screen.getByText("1 line")).toBeTruthy();
  });
});
