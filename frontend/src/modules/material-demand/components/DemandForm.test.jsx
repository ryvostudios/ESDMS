import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DemandForm } from "./DemandForm.jsx";

const mockListCatalog = vi.hoisted(() => vi.fn());
const mockListUnitsOfMeasure = vi.hoisted(() => vi.fn());
const mockSearchCompanyItems = vi.hoisted(() => vi.fn());

vi.mock("../../material-catalog/api.js", () => ({
  listCatalog: (...args) => mockListCatalog(...args),
  listAllCatalog: (...args) => mockListCatalog(...args),
  listUnitsOfMeasure: (...args) => mockListUnitsOfMeasure(...args),
  searchCompanyItems: (...args) => mockSearchCompanyItems(...args),
  addCatalogEntry: vi.fn(),
  updateCatalogEntry: vi.fn(),
}));

vi.mock("../../workforce/api.js", () => ({
  listDepartmentsManage: vi.fn(() => Promise.resolve({ data: [] })),
}));

const mockUser = { departmentId: "dept-civil" };
// Locked actor (no demand.all_departments) — matches the common Team Lead
// case, where the department is implicit rather than chosen from a list.
let mockPermissions = new Set();
vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({
    user: mockUser,
    hasPermission: (...codes) => codes.some((code) => mockPermissions.has(code)),
  }),
}));

beforeEach(() => {
  mockListUnitsOfMeasure.mockResolvedValue({ data: [{ id: "uom-1", code: "BAG", name: "Bags" }] });
  mockSearchCompanyItems.mockResolvedValue({ data: [] });
});

afterEach(() => {
  cleanup();
  mockListCatalog.mockReset();
  mockListUnitsOfMeasure.mockReset();
  mockSearchCompanyItems.mockReset();
  mockPermissions = new Set();
});

async function renderForm(onSubmit = vi.fn()) {
  await act(async () => {
    render(<DemandForm submitLabel="Save draft" onSubmit={onSubmit} />);
  });
  return onSubmit;
}

describe("DemandForm — catalog picker", () => {
  test("checking an item reveals a quantity field", async () => {
    mockListCatalog.mockResolvedValue({
      data: [{ id: "entry-1", item_name: "Cement", default_uom_name: "Bags" }],
      meta: { page: 1, pageSize: 200, total: 1 },
    });

    await renderForm();

    fireEvent.click(await screen.findByRole("checkbox", { name: "Cement" }));

    expect(screen.getByLabelText("Quantity for Cement")).toBeTruthy();
  });

  test("only checked items with a quantity are submitted — unchecked items are excluded", async () => {
    mockListCatalog.mockResolvedValue({
      data: [
        { id: "entry-1", item_name: "Cement", default_uom_name: "Bags" },
        { id: "entry-2", item_name: "Paint", default_uom_name: "Litres" },
      ],
      meta: { page: 1, pageSize: 200, total: 2 },
    });

    const onSubmit = await renderForm();

    fireEvent.click(await screen.findByRole("checkbox", { name: "Cement" }));
    fireEvent.change(screen.getByLabelText("Quantity for Cement"), { target: { value: "50" } });
    // Paint is left unchecked.

    fireEvent.click(screen.getByRole("button", { name: /save draft/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].lines).toEqual([{ catalogEntryId: "entry-1", quantity: 50 }]);
  });

  test("unchecking a previously selected item removes its line", async () => {
    mockListCatalog.mockResolvedValue({
      data: [{ id: "entry-1", item_name: "Cement", default_uom_name: "Bags" }],
      meta: { page: 1, pageSize: 200, total: 1 },
    });

    const onSubmit = await renderForm();

    const checkbox = await screen.findByRole("checkbox", { name: "Cement" });
    fireEvent.click(checkbox);
    fireEvent.change(screen.getByLabelText("Quantity for Cement"), { target: { value: "10" } });
    fireEvent.click(checkbox);

    expect(screen.queryByLabelText("Quantity for Cement")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /save draft/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].lines).toEqual([]);
  });

  test("+ Add Material reuses the Checkpoint 1 catalog dialog rather than a second implementation", async () => {
    mockListCatalog.mockResolvedValue({ data: [], meta: { page: 1, pageSize: 200, total: 0 } });

    await renderForm();

    fireEvent.click(await screen.findByRole("button", { name: "+ Add Material" }));

    expect(await screen.findByRole("dialog", { name: "Add Material" })).toBeTruthy();
  });
});

// A Draft line created from a carry-forward source carries an authoritative
// claim on that source. Reopening the Draft and saving it again must never
// silently turn it into an ordinary line — that would release the claim and
// let the same outstanding quantity be carried into another Demand as well.
describe("DemandForm — carry-forward source round-trip", () => {
  const DRAFT = { id: "demand-1", department_id: "dept-civil", note: "original note", status: "DRAFT" };

  function draftLine(overrides = {}) {
    return {
      id: "line-1",
      line_no: 1,
      catalog_entry_id: "entry-cable",
      item_name_snapshot: "Cable 2.5mm",
      uom_code_snapshot: "M",
      uom_name_snapshot: "Metres",
      requested_quantity: "40.00",
      note: null,
      carry_forward_source_type: "UNPURCHASED_IPO_QUANTITY",
      carry_forward_source_id: "ipo-line-32",
      carry_forward_quantity: "40.00",
      ...overrides,
    };
  }

  async function renderEdit(lines, onSubmit = vi.fn()) {
    mockListCatalog.mockResolvedValue({
      data: [
        { id: "entry-cable", item_name: "Cable 2.5mm", default_uom_name: "Metres" },
        { id: "entry-paint", item_name: "Paint", default_uom_name: "Litres" },
      ],
      meta: { page: 1, pageSize: 200, total: 2 },
    });
    await act(async () => {
      render(
        <DemandForm
          initialDemand={DRAFT}
          initialLines={lines}
          submitLabel="Save draft"
          onSubmit={onSubmit}
        />,
      );
    });
    return onSubmit;
  }

  const save = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    });
  };

  test("A — reopening a Draft and saving it unchanged preserves the source", async () => {
    const onSubmit = await renderEdit([draftLine()]);
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const [payload] = onSubmit.mock.calls[0];
    const line = payload.lines.find((entry) => entry.catalogEntryId === "entry-cable");

    expect(line.carryForward).toEqual({
      sourceType: "UNPURCHASED_IPO_QUANTITY",
      sourceId: "ipo-line-32",
      quantity: 40,
    });
  });

  test("B — editing the quantity keeps the same source and carries the smaller amount", async () => {
    const onSubmit = await renderEdit([draftLine()]);

    fireEvent.change(screen.getByLabelText("Quantity for Cable 2.5mm"), { target: { value: "25" } });
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const line = onSubmit.mock.calls[0][0].lines.find((entry) => entry.catalogEntryId === "entry-cable");

    expect(line.quantity).toBe(25);
    // Still a claim against the very same source — not a fresh 25-unit request.
    expect(line.carryForward.sourceId).toBe("ipo-line-32");
    expect(line.carryForward.sourceType).toBe("UNPURCHASED_IPO_QUANTITY");
    // Never claim more than the line actually asks for.
    expect(line.carryForward.quantity).toBe(25);
  });

  test("C — editing an unrelated field leaves the source untouched", async () => {
    const onSubmit = await renderEdit([draftLine()]);

    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: "revised note" } });
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const [payload] = onSubmit.mock.calls[0];
    expect(payload.note).toBe("revised note");
    expect(payload.lines[0].carryForward.sourceId).toBe("ipo-line-32");
  });

  test("D — removing the line removes its claim, and re-adding it is an ordinary request", async () => {
    const onSubmit = await renderEdit([draftLine()]);

    // Unchecking removes the line entirely.
    fireEvent.click(screen.getByRole("checkbox", { name: "Cable 2.5mm" }));
    // Re-adding it by hand is a new, unsourced requirement.
    fireEvent.click(screen.getByRole("checkbox", { name: "Cable 2.5mm" }));
    fireEvent.change(screen.getByLabelText("Quantity for Cable 2.5mm"), { target: { value: "12" } });
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const line = onSubmit.mock.calls[0][0].lines.find((entry) => entry.catalogEntryId === "entry-cable");
    expect(line.quantity).toBe(12);
    expect(line.carryForward).toBeUndefined();
  });

  test("E — every supported source type round-trips, not just the IPO shortfall", async () => {
    const onSubmit = await renderEdit([
      draftLine(),
      draftLine({
        id: "line-2",
        line_no: 2,
        catalog_entry_id: "entry-paint",
        item_name_snapshot: "Paint",
        requested_quantity: "20.00",
        carry_forward_source_type: "OUT_OF_BUDGET",
        carry_forward_source_id: "disposition-7",
        carry_forward_quantity: "20.00",
      }),
    ]);
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const lines = onSubmit.mock.calls[0][0].lines;
    expect(lines.find((l) => l.catalogEntryId === "entry-cable").carryForward.sourceType).toBe(
      "UNPURCHASED_IPO_QUANTITY",
    );
    expect(lines.find((l) => l.catalogEntryId === "entry-paint").carryForward).toEqual({
      sourceType: "OUT_OF_BUDGET",
      sourceId: "disposition-7",
      quantity: 20,
    });
  });

  test("an ordinary Draft line is still submitted without any source", async () => {
    const onSubmit = await renderEdit([
      draftLine({
        carry_forward_source_type: null,
        carry_forward_source_id: null,
        carry_forward_quantity: null,
      }),
    ]);
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].lines[0].carryForward).toBeUndefined();
  });
});
