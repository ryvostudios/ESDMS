// P4-1 at the component level: the picker must actually load materials for a
// department-scoped Team Lead and for a company-wide actor who has chosen a
// department, and it must surface a real reason when the load is refused
// rather than the bare "Invalid request." it used to show.
import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { DemandItemPicker } from "./DemandItemPicker.jsx";
import { ApiError } from "../../../core/api/client.js";

const mockListAllCatalog = vi.hoisted(() => vi.fn());
const mockListUnitsOfMeasure = vi.hoisted(() => vi.fn());

vi.mock("../../material-catalog/api.js", () => ({
  listCatalog: vi.fn(),
  listAllCatalog: (...args) => mockListAllCatalog(...args),
  listUnitsOfMeasure: (...args) => mockListUnitsOfMeasure(...args),
  searchCompanyItems: vi.fn(),
  addCatalogEntry: vi.fn(),
  updateCatalogEntry: vi.fn(),
}));

vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({ user: { departmentId: "dept-civil" }, hasPermission: () => true }),
}));

afterEach(() => {
  cleanup();
  mockListAllCatalog.mockReset();
  mockListUnitsOfMeasure.mockReset();
});

async function renderPicker(departmentId) {
  mockListUnitsOfMeasure.mockResolvedValue({ data: [] });
  await act(async () => {
    render(<DemandItemPicker departmentId={departmentId} selections={{}} onChange={() => {}} />);
  });
}

describe("DemandItemPicker loads the department catalog", () => {
  test("a Civil Team Lead sees Civil materials", async () => {
    mockListAllCatalog.mockResolvedValue({
      data: [{ id: "entry-civil", item_name: "Cement", default_uom_name: "Bags" }],
      meta: { total: 1, truncated: false },
    });
    await renderPicker("dept-civil");

    expect(mockListAllCatalog).toHaveBeenCalledWith({ departmentId: "dept-civil" });
    expect(screen.getByText("Cement")).toBeTruthy();
  });

  test("an Electrical Team Lead sees Electrical materials", async () => {
    mockListAllCatalog.mockResolvedValue({
      data: [{ id: "entry-elec", item_name: "Cable 4mm", default_uom_name: "Metres" }],
      meta: { total: 1, truncated: false },
    });
    await renderPicker("dept-elec");

    expect(mockListAllCatalog).toHaveBeenCalledWith({ departmentId: "dept-elec" });
    expect(screen.getByText("Cable 4mm")).toBeTruthy();
  });

  test("a company-wide actor loads nothing until a department is chosen, then loads it", async () => {
    await renderPicker("");
    expect(mockListAllCatalog).not.toHaveBeenCalled();
    cleanup();

    mockListAllCatalog.mockResolvedValue({
      data: [{ id: "entry-civil", item_name: "Cement", default_uom_name: "Bags" }],
      meta: { total: 1, truncated: false },
    });
    await renderPicker("dept-civil");
    expect(mockListAllCatalog).toHaveBeenCalledWith({ departmentId: "dept-civil" });
    expect(screen.getByText("Cement")).toBeTruthy();
  });

  test("a refused load shows the server's actual reason, not a generic message", async () => {
    mockListAllCatalog.mockRejectedValue(
      new ApiError(400, "VALIDATION_ERROR", "Invalid request.", {
        formErrors: [],
        fieldErrors: { pageSize: ["Too big: expected number to be <=100"] },
      }),
    );
    await renderPicker("dept-civil");

    expect(screen.getByText(/Too big: expected number to be <=100/)).toBeTruthy();
  });

  test("a non-API failure still shows plain language", async () => {
    mockListAllCatalog.mockRejectedValue(new TypeError("boom"));
    await renderPicker("dept-civil");
    expect(screen.getByText("Unable to load the material catalog.")).toBeTruthy();
  });
});
