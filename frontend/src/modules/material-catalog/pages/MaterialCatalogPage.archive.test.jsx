// P4-4 regression. Archiving a material used to be a one-way trip through
// the UI: the list never asked for inactive rows, so an archived material
// could not be found again and the existing "Restore" control was
// unreachable. Archiving also fired instantly with no confirmation.
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiError } from "../../../core/api/client.js";
import { MaterialCatalogPage } from "./MaterialCatalogPage.jsx";

const mockListCatalog = vi.hoisted(() => vi.fn());
const mockListUnitsOfMeasure = vi.hoisted(() => vi.fn());
const mockUpdateCatalogEntry = vi.hoisted(() => vi.fn());
const mockUpdateCompanyItem = vi.hoisted(() => vi.fn());

vi.mock("../api.js", () => ({
  listCatalog: (...args) => mockListCatalog(...args),
  listAllCatalog: (...args) => mockListCatalog(...args),
  listUnitsOfMeasure: (...args) => mockListUnitsOfMeasure(...args),
  searchCompanyItems: vi.fn(),
  addCatalogEntry: vi.fn(),
  updateCatalogEntry: (...args) => mockUpdateCatalogEntry(...args),
  updateCompanyItem: (...args) => mockUpdateCompanyItem(...args),
}));

vi.mock("../../workforce/api.js", () => ({
  listDepartmentsManage: () => Promise.resolve({ data: [] }),
}));

let mockPermissions = new Set(["material_catalog.view", "material_catalog.manage"]);
vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({
    user: { departmentId: "dept-civil" },
    hasPermission: (...codes) => codes.some((code) => mockPermissions.has(code)),
  }),
}));

function row(overrides = {}) {
  return {
    id: "entry-1",
    item_name: "Cement",
    default_uom_name: "Bags",
    is_active: true,
    department_id: "dept-civil",
    department_name: "Civil",
    company_item_id: "item-1",
    company_item_is_active: true,
    ...overrides,
  };
}

function respondWith(rows) {
  mockListCatalog.mockResolvedValue({ data: rows, meta: { page: 1, pageSize: 50, total: rows.length } });
}

beforeEach(() => {
  mockListUnitsOfMeasure.mockResolvedValue({ data: [] });
  mockUpdateCatalogEntry.mockResolvedValue({ data: {} });
  mockUpdateCompanyItem.mockResolvedValue({ data: {} });
  mockPermissions = new Set(["material_catalog.view", "material_catalog.manage"]);
});

afterEach(() => {
  cleanup();
  mockListCatalog.mockReset();
  mockListUnitsOfMeasure.mockReset();
  mockUpdateCatalogEntry.mockReset();
  mockUpdateCompanyItem.mockReset();
});

async function renderPage() {
  await act(async () => {
    render(<MaterialCatalogPage />);
  });
}

// The table and the mobile card list both render every row, so scope the
// assertions to the table to avoid matching the same material twice.
function inTable() {
  return within(screen.getByRole("table"));
}

describe("Material catalog removal / restore lifecycle", () => {
  test("removal asks for confirmation first and does nothing if cancelled", async () => {
    respondWith([row()]);
    await renderPage();

    fireEvent.click(inTable().getByRole("button", { name: "Remove from Catalog" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Remove from Catalog" })).toBeTruthy();
    expect(within(dialog).getByText(/Historical Demands and records will not be changed/i)).toBeTruthy();
    expect(mockUpdateCatalogEntry).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockUpdateCatalogEntry).not.toHaveBeenCalled();
  });

  test("confirming removes the entry from new selections", async () => {
    respondWith([row()]);
    await renderPage();

    fireEvent.click(inTable().getByRole("button", { name: "Remove from Catalog" }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove from Catalog" }));
    });

    await waitFor(() => expect(mockUpdateCatalogEntry).toHaveBeenCalledWith("entry-1", { isActive: false }));
  });

  test("the default view asks only for active rows", async () => {
    respondWith([row()]);
    await renderPage();

    for (const [params] of mockListCatalog.mock.calls) {
      expect(params.includeInactive).toBeUndefined();
    }
  });

  test("switching to All statuses re-queries with includeInactive", async () => {
    respondWith([row()]);
    await renderPage();
    mockListCatalog.mockClear();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Status"), { target: { value: "all" } });
    });

    await waitFor(() => expect(mockListCatalog).toHaveBeenCalled());
    expect(mockListCatalog.mock.calls.at(-1)[0].includeInactive).toBe("true");
  });

  test("an archived row is shown as Archived and Restore to Catalog is confirmed", async () => {
    respondWith([row({ is_active: false })]);
    await renderPage();

    expect(inTable().getByText("Archived")).toBeTruthy();
    const restore = inTable().getByRole("button", { name: "Restore to Catalog" });

    await act(async () => {
      fireEvent.click(restore);
    });

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/available for new Demand selections again/i)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Restore to Catalog" }));
    });
    await waitFor(() => expect(mockUpdateCatalogEntry).toHaveBeenCalledWith("entry-1", { isActive: true }));
  });

  test("a failed archive reports the server's reason instead of failing silently", async () => {
    respondWith([row()]);
    await renderPage();
    mockUpdateCatalogEntry.mockRejectedValue(
      new ApiError(404, "NOT_FOUND", "Material catalog entry not found."),
    );

    fireEvent.click(inTable().getByRole("button", { name: "Remove from Catalog" }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove from Catalog" }));
    });

    expect(await screen.findByText(/Material catalog entry not found\./)).toBeTruthy();
  });

  test("a viewer without manage permission gets no removal or restore control", async () => {
    mockPermissions = new Set(["material_catalog.view"]);
    respondWith([row()]);
    await renderPage();

    expect(screen.queryByRole("button", { name: "Remove from Catalog" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore to Catalog" })).toBeNull();
  });

  test("company-wide managers can edit metadata and must confirm Company Item archival", async () => {
    mockPermissions = new Set(["material_catalog.view", "material_catalog.manage", "material_catalog.all_departments"]);
    respondWith([row()]);
    await renderPage();

    fireEvent.click(inTable().getByRole("button", { name: "Edit Item" }));
    const editDialog = await screen.findByRole("dialog");
    fireEvent.change(within(editDialog).getByLabelText(/Material name/), { target: { value: "Cement Grade A" } });
    await act(async () => {
      fireEvent.click(within(editDialog).getByRole("button", { name: "Save Company Item" }));
    });
    expect(mockUpdateCompanyItem).toHaveBeenCalledWith("item-1", { name: "Cement Grade A", description: null });

    fireEvent.click(inTable().getByRole("button", { name: "Archive Company Item" }));
    const archiveDialog = await screen.findByRole("dialog");
    expect(within(archiveDialog).getByText(/removed from every department catalog/i)).toBeTruthy();
    expect(mockUpdateCompanyItem).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(within(archiveDialog).getByRole("button", { name: "Archive Company Item" }));
    });
    expect(mockUpdateCompanyItem).toHaveBeenLastCalledWith("item-1", { isActive: false });
  });
});
