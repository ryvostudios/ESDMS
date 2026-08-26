import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PricingPage } from "./PricingPage.jsx";

const mockUsePricing = vi.hoisted(() => vi.fn());
const mockSavePricing = vi.hoisted(() => vi.fn());
const mockSubmitPricing = vi.hoisted(() => vi.fn());
const mockGetPricing = vi.hoisted(() => vi.fn());

vi.mock("../hooks/usePricing.js", () => ({
  usePricing: (...args) => mockUsePricing(...args),
}));

vi.mock("../api.js", () => ({
  savePricing: (...args) => mockSavePricing(...args),
  submitPricing: (...args) => mockSubmitPricing(...args),
  getPricing: (...args) => mockGetPricing(...args),
}));

function pricingDetail(overrides = {}) {
  return {
    demand: {
      id: "demand-1",
      demand_number: "DL-2026-000024",
      department_name: "Civil",
      status: "READY_FOR_PRICING",
      revision: 1,
    },
    pricing: null,
    lines: [
      {
        demand_line_id: "line-1",
        line_no: 1,
        item_name_snapshot: "Cement",
        uom_name_snapshot: "Bags",
        requested_quantity: "50.00",
        estimated_unit_price: null,
        procurement_note: null,
        line_total: null,
      },
      {
        demand_line_id: "line-2",
        line_no: 2,
        item_name_snapshot: "Binding Wire",
        uom_name_snapshot: "Kg",
        requested_quantity: "20.00",
        estimated_unit_price: null,
        procurement_note: null,
        line_total: null,
      },
    ],
    estimatedTotal: "0.00",
    canEdit: true,
    ...overrides,
  };
}

async function renderPage(result = pricingDetail()) {
  const reload = vi.fn().mockResolvedValue(result);
  mockUsePricing.mockReturnValue({ result, status: "ready", error: null, reload });
  await act(async () => {
    render(
      <MemoryRouter initialEntries={["/procurement/pricing/demand-1"]}>
        <Routes>
          <Route path="/procurement/pricing/:demandId" element={<PricingPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return reload;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PricingPage", () => {
  test("renders the exact approved lines with read-only quantity and UOM", async () => {
    await renderPage();
    expect(screen.getByText("Cement")).toBeTruthy();
    expect(screen.getByText("Binding Wire")).toBeTruthy();
    expect(screen.getByText("50.00")).toBeTruthy();
    expect(screen.getByText("Bags")).toBeTruthy();
    expect(screen.getByText(/previous purchase price is unavailable/i)).toBeTruthy();
    expect(screen.getAllByRole("textbox")).toHaveLength(4); // two prices + two optional notes
  });

  test("calculates display-only line and overall totals", async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText("Estimated unit price for Cement"), { target: { value: "1450.00" } });
    fireEvent.change(screen.getByLabelText("Estimated unit price for Binding Wire"), { target: { value: "620.00" } });

    expect(screen.getByText("Rs 72,500.00")).toBeTruthy();
    expect(screen.getByText("Rs 12,400.00")).toBeTruthy();
    expect(screen.getByText("Rs 84,900.00")).toBeTruthy();
  });

  test("saves a partial draft without changing quantity, UOM, or sending totals", async () => {
    const saved = pricingDetail({ pricing: { id: "pricing-1", status: "DRAFT", currency: "PKR" } });
    mockSavePricing.mockResolvedValue({ data: saved });
    await renderPage();

    fireEvent.change(screen.getByLabelText("Estimated unit price for Cement"), { target: { value: "100.00" } });
    fireEvent.change(screen.getByLabelText("Procurement note for Cement"), { target: { value: "Supplier quote" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));

    await waitFor(() => expect(mockSavePricing).toHaveBeenCalledTimes(1));
    expect(mockSavePricing.mock.calls[0][0]).toBe("demand-1");
    expect(mockSavePricing.mock.calls[0][1]).toEqual({
      revision: 1,
      currency: "PKR",
      lines: [{ demandLineId: "line-1", estimatedUnitPrice: "100.00", procurementNote: "Supplier quote" }],
    });
    expect(JSON.stringify(mockSavePricing.mock.calls[0][1])).not.toContain("total");
    expect(JSON.stringify(mockSavePricing.mock.calls[0][1])).not.toContain("quantity");
  });

  test("prevents incomplete submission", async () => {
    await renderPage();
    const submit = screen.getByRole("button", { name: "Submit Pricing" });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Estimated unit price for Cement"), { target: { value: "10.00" } });
    expect(submit.disabled).toBe(true);
    expect(mockSubmitPricing).not.toHaveBeenCalled();
  });

  test("does not silently discard a malformed entered price when saving", async () => {
    mockSavePricing.mockRejectedValue(new Error("Invalid request."));
    await renderPage();
    fireEvent.change(screen.getByLabelText("Estimated unit price for Cement"), { target: { value: "NaN" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));
    await waitFor(() => expect(mockSavePricing).toHaveBeenCalled());
    expect(mockSavePricing.mock.calls[0][1].lines[0].estimatedUnitPrice).toBe("NaN");
    expect(await screen.findByText("Invalid request.")).toBeTruthy();
  });

  test("submits complete pricing and changes the screen to immutable pending-final state", async () => {
    const submitted = pricingDetail({
      demand: { ...pricingDetail().demand, status: "PENDING_FINAL_APPROVAL" },
      pricing: { id: "pricing-1", status: "SUBMITTED", currency: "PKR" },
      lines: pricingDetail().lines.map((line, index) => ({
        ...line,
        estimated_unit_price: index === 0 ? "100.00" : "2.50",
        line_total: index === 0 ? "5000.00" : "50.00",
      })),
      estimatedTotal: "5050.00",
      canEdit: false,
    });
    mockSavePricing.mockResolvedValue({ data: pricingDetail() });
    mockSubmitPricing.mockResolvedValue({ data: submitted });
    mockGetPricing.mockResolvedValue({ data: submitted });
    await renderPage();

    fireEvent.change(screen.getByLabelText("Estimated unit price for Cement"), { target: { value: "100.00" } });
    fireEvent.change(screen.getByLabelText("Estimated unit price for Binding Wire"), { target: { value: "2.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit Pricing" }));

    await waitFor(() => expect(mockSubmitPricing).toHaveBeenCalledWith("demand-1", { revision: 1 }));
    expect(await screen.findByText("Pending Final Management Review / Formal Approval")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save Draft" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit Pricing" })).toBeNull();
    expect(screen.getByLabelText("Estimated unit price for Cement").readOnly).toBe(true);
  });

  test("renders loading and error states", async () => {
    mockUsePricing.mockReturnValue({ result: null, status: "loading", error: null, reload: vi.fn() });
    await act(async () => {
      render(<MemoryRouter><PricingPage /></MemoryRouter>);
    });
    expect(screen.getByText(/loading procurement pricing/i)).toBeTruthy();

    cleanup();
    mockUsePricing.mockReturnValue({ result: null, status: "error", error: "Pricing unavailable", reload: vi.fn() });
    await act(async () => {
      render(<MemoryRouter><PricingPage /></MemoryRouter>);
    });
    expect(screen.getByText("Pricing unavailable")).toBeTruthy();
  });
});
