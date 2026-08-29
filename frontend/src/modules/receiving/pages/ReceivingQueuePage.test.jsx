import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ReceivingQueuePage } from "./ReceivingQueuePage.jsx";

const mockListOpenDeliveries = vi.hoisted(() => vi.fn());
const mockListReceipts = vi.hoisted(() => vi.fn());

vi.mock("../api.js", () => ({
  listOpenDeliveries: (...args) => mockListOpenDeliveries(...args),
  listReceipts: (...args) => mockListReceipts(...args),
}));

afterEach(() => {
  cleanup();
  mockListOpenDeliveries.mockReset();
  mockListReceipts.mockReset();
});

async function renderPage() {
  await act(async () => {
    render(
      <MemoryRouter>
        <ReceivingQueuePage />
      </MemoryRouter>,
    );
  });
}

describe("ReceivingQueuePage", () => {
  test("separates work waiting on the user from deliveries still to receive", async () => {
    mockListOpenDeliveries.mockResolvedValue({
      data: [
        {
          id: "dc-1",
          dc_number: "ESET-DC/2026/8",
          status: "FINALIZED",
          department_name: "Civil",
          ipo_number: "ESET/2026/32",
          line_count: 2,
        },
      ],
    });
    mockListReceipts
      .mockResolvedValueOnce({
        data: [
          {
            id: "r-1",
            dc_number: "ESET-DC/2026/7",
            receipt_type: "ADMIN_FALLBACK",
            status: "AWAITING_HANDOVER",
            received_by_name: "Test Admin",
            received_at: "2026-08-03T09:00:00.000Z",
            has_discrepancy: false,
          },
        ],
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "r-2",
            dc_number: "ESET-DC/2026/6",
            receipt_type: "DEPARTMENT",
            status: "PENDING_CONFIRMATION",
            received_by_name: "Test Employee",
            received_at: "2026-08-02T09:00:00.000Z",
            has_discrepancy: true,
          },
        ],
      });

    await renderPage();

    expect(screen.getByText("Awaiting department handover")).toBeTruthy();
    expect(screen.getByText("Pending confirmation")).toBeTruthy();
    expect(screen.getByText(/temporary site administrator custody/i)).toBeTruthy();
    expect(screen.getByText("ESET-DC/2026/8")).toBeTruthy();
    expect(screen.getByText("Discrepancy")).toBeTruthy();
  });

  test("renders empty and error states", async () => {
    mockListOpenDeliveries.mockResolvedValue({ data: [] });
    mockListReceipts.mockResolvedValue({ data: [] });
    await renderPage();
    expect(screen.getByText("Nothing pending")).toBeTruthy();
    expect(screen.getByText("No deliveries waiting")).toBeTruthy();

    cleanup();
    mockListOpenDeliveries.mockRejectedValue(new Error("Receiving unavailable"));
    mockListReceipts.mockResolvedValue({ data: [] });
    await renderPage();
    expect(screen.getByText("Receiving unavailable")).toBeTruthy();
  });
});
