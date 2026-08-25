import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DemandForm } from "./DemandForm.jsx";

const mockListCatalog = vi.hoisted(() => vi.fn());
const mockListUnitsOfMeasure = vi.hoisted(() => vi.fn());
const mockSearchCompanyItems = vi.hoisted(() => vi.fn());

vi.mock("../../material-catalog/api.js", () => ({
  listCatalog: (...args) => mockListCatalog(...args),
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
