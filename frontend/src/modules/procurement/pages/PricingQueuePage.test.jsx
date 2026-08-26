import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PricingQueuePage } from "./PricingQueuePage.jsx";

const mockUsePricingQueue = vi.hoisted(() => vi.fn());
vi.mock("../hooks/usePricingQueue.js", () => ({
  usePricingQueue: (...args) => mockUsePricingQueue(...args),
}));

afterEach(() => {
  cleanup();
  mockUsePricingQueue.mockReset();
});

async function renderPage() {
  await act(async () => {
    render(<MemoryRouter><PricingQueuePage /></MemoryRouter>);
  });
}

describe("PricingQueuePage", () => {
  test("renders only server-returned ready work and draft state", async () => {
    mockUsePricingQueue.mockReturnValue({
      rows: [
        { id: "demand-1", demand_number: "DL-0024", department_name: "Civil", line_count: 4, pricing_id: null },
        { id: "demand-2", demand_number: "DL-0025", department_name: "WTG", line_count: 7, pricing_id: "pricing-2" },
      ],
      total: 2,
      status: "ready",
      error: null,
      reload: vi.fn(),
    });
    await renderPage();
    expect(screen.getByText("DL-0024")).toBeTruthy();
    expect(screen.getByText("4 items")).toBeTruthy();
    expect(screen.getByText("Ready for Pricing")).toBeTruthy();
    expect(screen.getByText("Draft saved")).toBeTruthy();
  });

  test("renders loading, empty, and error states", async () => {
    mockUsePricingQueue.mockReturnValue({ rows: [], total: 0, status: "loading", error: null, reload: vi.fn() });
    await renderPage();
    expect(screen.getByText(/loading procurement queue/i)).toBeTruthy();

    cleanup();
    mockUsePricingQueue.mockReturnValue({ rows: [], total: 0, status: "ready", error: null, reload: vi.fn() });
    await renderPage();
    expect(screen.getByText("No Demands ready for pricing")).toBeTruthy();

    cleanup();
    mockUsePricingQueue.mockReturnValue({ rows: [], total: 0, status: "error", error: "Queue unavailable", reload: vi.fn() });
    await renderPage();
    expect(screen.getByText("Queue unavailable")).toBeTruthy();
  });
});

