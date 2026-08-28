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

vi.mock("../api.js", () => ({
  listCatalog: (...args) => mockListCatalog(...args),
  listAllCatalog: (...args) => mockListCatalog(...args),
  listUnitsOfMeasure: (...args) => mockListUnitsOfMeasure(...args),
  searchCompanyItems: vi.fn(),
  addCatalogEntry: vi.fn(),
  updateCatalogEntry: (...args) => mockUpdateCatalogEntry(...args),
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
    ...overrides,
  };
}

function respondWith(rows) {
  mockListCatalog.mockResolvedValue({ data: rows, meta: { page: 1, pageSize: 50, total: rows.length } });
}

beforeEach(() => {
  mockListUnitsOfMeasure.mockResolvedValue({ data: [] });
  mockUpdateCatalogEntry.mockResolvedValue({ data: {} });
  mockPermissions = new Set(["material_catalog.view", "material_catalog.manage"]);
});

afterEach(() => {
  cleanup();
  mockListCatalog.mockReset();
  mockListUnitsOfMeasure.mockReset();
  mockUpdateCatalogEntry.mockReset();
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

describe("Material archive / reactivate lifecycle", () => {
  test("archiving asks for confirmation first and does nothing if cancelled", async () => {
    respondWith([row()]);
    await renderPage();

    fireEvent.click(inTable().getByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Archive material/i)).toBeTruthy();
    expect(within(dialog).getByText(/Cement/)).toBeTruthy();
    expect(mockUpdateCatalogEntry).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockUpdateCatalogEntry).not.toHaveBeenCalled();
  });

  test("confirming archives the entry", async () => {
    respondWith([row()]);
    await renderPage();

    fireEvent.click(inTable().getByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
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

  test("an archived row is shown as Archived and offers Restore, with no confirmation", async () => {
    respondWith([row({ is_active: false })]);
    await renderPage();

    expect(inTable().getByText("Archived")).toBeTruthy();
    const restore = inTable().getByRole("button", { name: "Restore" });

    await act(async () => {
      fireEvent.click(restore);
    });

    // Restoring only puts a choice back, so it is not gated behind a dialog.
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(mockUpdateCatalogEntry).toHaveBeenCalledWith("entry-1", { isActive: true }));
  });

  test("a failed archive reports the server's reason instead of failing silently", async () => {
    respondWith([row()]);
    await renderPage();
    mockUpdateCatalogEntry.mockRejectedValue(
      new ApiError(404, "NOT_FOUND", "Material catalog entry not found."),
    );

    fireEvent.click(inTable().getByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    });

    expect(await screen.findByText(/Material catalog entry not found\./)).toBeTruthy();
  });

  test("a viewer without manage permission gets no archive or restore control", async () => {
    mockPermissions = new Set(["material_catalog.view"]);
    respondWith([row()]);
    await renderPage();

    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });
});
