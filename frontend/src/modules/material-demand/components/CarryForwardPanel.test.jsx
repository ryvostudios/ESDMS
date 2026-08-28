import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CarryForwardPanel } from "./CarryForwardPanel.jsx";

const mockListCatalog = vi.hoisted(() => vi.fn());
const mockListOutstanding = vi.hoisted(() => vi.fn());

vi.mock("../../material-catalog/api.js", () => ({
  listCatalog: (...args) => mockListCatalog(...args),
  listAllCatalog: (...args) => mockListCatalog(...args),
}));
vi.mock("../api.js", () => ({
  listOutstandingForCatalogEntries: (...args) => mockListOutstanding(...args),
}));

afterEach(() => {
  cleanup();
  mockListCatalog.mockReset();
  mockListOutstanding.mockReset();
});

async function renderPanel(props = {}) {
  await act(async () => {
    render(
      <CarryForwardPanel departmentId="dept-1" selections={{}} onAdd={props.onAdd || vi.fn()} {...props} />,
    );
  });
}

describe("CarryForwardPanel", () => {
  test("surfaces both short-purchased and management-excluded requirements with their source", async () => {
    mockListCatalog.mockResolvedValue({ data: [{ id: "entry-1" }, { id: "entry-2" }] });
    mockListOutstanding.mockResolvedValue({
      data: [
        {
          catalog_entry_id: "entry-1",
          source_type: "UNPURCHASED_IPO_QUANTITY",
          source_id: "ipo-line-1",
          company_item_id: "item-1",
          demand_id: "demand-1",
          demand_number: "DL-2026-000004",
          ipo_number: "ESET/2026/32",
          item_name_snapshot: "Cable 2.5mm",
          uom_code_snapshot: "M",
          source_quantity: "40.00",
          allocated_quantity: "0.00",
          available_quantity: "40.00",
          resolved_at: "2026-08-01T09:00:00.000Z",
        },
        {
          catalog_entry_id: "entry-2",
          source_type: "OUT_OF_BUDGET",
          source_id: "disposition-1",
          company_item_id: "item-2",
          demand_id: "demand-2",
          demand_number: "DL-2026-000005",
          ipo_number: null,
          item_name_snapshot: "Paint",
          uom_code_snapshot: "L",
          source_quantity: "20.00",
          allocated_quantity: "0.00",
          available_quantity: "20.00",
          exclusion_category: "OUT_OF_BUDGET",
        },
      ],
    });

    await renderPanel();

    expect(screen.getByText("Cable 2.5mm")).toBeTruthy();
    expect(screen.getByText(/Outstanding available: 40.00 M/)).toBeTruthy();
    expect(screen.getByText(/approved but not fully purchased/i)).toBeTruthy();
    expect(screen.getByText(/source: ESET\/2026\/32/i)).toBeTruthy();

    expect(screen.getByText("Paint")).toBeTruthy();
    expect(screen.getByText(/excluded by management — out of budget/i)).toBeTruthy();
  });

  test("adding a candidate suggests its quantity but never submits anything", async () => {
    const onAdd = vi.fn();
    mockListCatalog.mockResolvedValue({ data: [{ id: "entry-1" }] });
    mockListOutstanding.mockResolvedValue({
      data: [
        {
          catalog_entry_id: "entry-1",
          source_type: "UNPURCHASED_IPO_QUANTITY",
          source_id: "ipo-line-1",
          company_item_id: "item-1",
          demand_id: "demand-1",
          demand_number: "DL-2026-000004",
          ipo_number: "ESET/2026/32",
          item_name_snapshot: "Cable 2.5mm",
          uom_code_snapshot: "M",
          source_quantity: "40.00",
          allocated_quantity: "0.00",
          available_quantity: "40.00",
        },
      ],
    });

    await renderPanel({ onAdd });
    fireEvent.click(screen.getByRole("button", { name: /carry forward/i }));
    // The claim carries its authoritative source, not just a quantity — that
    // linkage is what stops the same shortfall being carried twice.
    expect(onAdd).toHaveBeenCalledWith("entry-1", "40.00", {
      sourceType: "UNPURCHASED_IPO_QUANTITY",
      sourceId: "ipo-line-1",
      quantity: 40,
    });
  });

  test("an already-selected item cannot be added twice", async () => {
    mockListCatalog.mockResolvedValue({ data: [{ id: "entry-1" }] });
    mockListOutstanding.mockResolvedValue({
      data: [
        {
          catalog_entry_id: "entry-1",
          source_type: "UNPURCHASED_IPO_QUANTITY",
          source_id: "ipo-line-1",
          company_item_id: "item-1",
          demand_id: "demand-1",
          demand_number: "DL-2026-000004",
          item_name_snapshot: "Cable 2.5mm",
          uom_code_snapshot: "M",
          source_quantity: "40.00",
          allocated_quantity: "0.00",
          available_quantity: "40.00",
        },
      ],
    });

    await renderPanel({ selections: { "entry-1": "10" } });
    expect(screen.getByRole("button", { name: /already in this demand/i }).disabled).toBe(true);
  });

  test("shows what remains after earlier Demands already claimed part of it", async () => {
    mockListCatalog.mockResolvedValue({ data: [{ id: "entry-1" }] });
    mockListOutstanding.mockResolvedValue({
      data: [
        {
          catalog_entry_id: "entry-1",
          source_type: "UNPURCHASED_IPO_QUANTITY",
          source_id: "ipo-line-1",
          company_item_id: "item-1",
          demand_id: "demand-1",
          demand_number: "DL-2026-000004",
          ipo_number: "ESET/2026/32",
          item_name_snapshot: "Cable 2.5mm",
          uom_code_snapshot: "M",
          source_quantity: "40.00",
          allocated_quantity: "25.00",
          available_quantity: "15.00",
        },
      ],
    });

    const onAdd = vi.fn();
    await renderPanel({ onAdd });

    // The original shortfall, what is already claimed, and what is left are
    // all stated — the user can never over-claim by accident.
    expect(screen.getByText(/Outstanding available: 15.00 M/)).toBeTruthy();
    expect(screen.getByText(/25.00 already carried into later Demands/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /carry forward/i }));
    expect(onAdd).toHaveBeenCalledWith("entry-1", "15.00", {
      sourceType: "UNPURCHASED_IPO_QUANTITY",
      sourceId: "ipo-line-1",
      quantity: 15,
    });
  });

  test("a confirmed delivery shortage is offered as its own distinct source", async () => {
    mockListCatalog.mockResolvedValue({ data: [{ id: "entry-1" }] });
    mockListOutstanding.mockResolvedValue({
      data: [
        {
          catalog_entry_id: "entry-1",
          source_type: "RECEIVING_SHORTAGE",
          source_id: "receipt-line-1",
          company_item_id: "item-1",
          demand_id: "demand-1",
          demand_number: "DL-2026-000004",
          ipo_number: "ESET/2026/32",
          item_name_snapshot: "Cement",
          uom_code_snapshot: "BAG",
          source_quantity: "40.00",
          allocated_quantity: "0.00",
          available_quantity: "40.00",
          discrepancy_type: "SHORT",
        },
      ],
    });

    await renderPanel();
    expect(screen.getByText(/delivered short — short/i)).toBeTruthy();
  });

  test("renders nothing at all when there is no unresolved history", async () => {
    mockListCatalog.mockResolvedValue({ data: [{ id: "entry-1" }] });
    mockListOutstanding.mockResolvedValue({ data: [] });
    const { container } = render(
      <CarryForwardPanel departmentId="dept-1" selections={{}} onAdd={vi.fn()} />,
    );
    await act(async () => {});
    expect(container.querySelector("section")).toBeNull();
  });

  test("a failed lookup is silent — carry-forward never blocks Demand creation", async () => {
    mockListCatalog.mockRejectedValue(new Error("Forbidden"));
    const { container } = render(
      <CarryForwardPanel departmentId="dept-1" selections={{}} onAdd={vi.fn()} />,
    );
    await act(async () => {});
    expect(container.querySelector("section")).toBeNull();
  });
});
