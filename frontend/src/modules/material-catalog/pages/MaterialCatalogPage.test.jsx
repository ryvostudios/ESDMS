import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ApiError } from "../../../core/api/client.js";
import { MaterialCatalogPage } from "./MaterialCatalogPage.jsx";

const mockListCatalog = vi.hoisted(() => vi.fn());
const mockListUnitsOfMeasure = vi.hoisted(() => vi.fn());

vi.mock("../api.js", () => ({
  listCatalog: (...args) => mockListCatalog(...args),
  listUnitsOfMeasure: (...args) => mockListUnitsOfMeasure(...args),
  searchCompanyItems: vi.fn(),
  addCatalogEntry: vi.fn(),
  updateCatalogEntry: vi.fn(),
}));

vi.mock("../../workforce/api.js", () => ({
  listDepartmentsManage: () => Promise.resolve({ data: [] }),
}));

let mockPermissions = new Set();
let mockUser = { departmentId: "dept-civil" };
vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({
    user: mockUser,
    hasPermission: (...codes) => codes.some((code) => mockPermissions.has(code)),
  }),
}));

beforeEach(() => {
  mockListUnitsOfMeasure.mockResolvedValue({ data: [] });
});

afterEach(() => {
  cleanup();
  mockListCatalog.mockReset();
  mockListUnitsOfMeasure.mockReset();
  mockPermissions = new Set();
  mockUser = { departmentId: "dept-civil" };
});

async function renderPage() {
  await act(async () => {
    render(<MaterialCatalogPage />);
  });
}

describe("MaterialCatalogPage", () => {
  test("renders a department's catalog rows", async () => {
    mockListCatalog.mockResolvedValue({
      data: [
        {
          id: "entry-1",
          item_name: "Cement",
          default_uom_name: "Bags",
          is_active: true,
          department_id: "dept-civil",
          department_name: "Civil",
        },
      ],
      meta: { page: 1, pageSize: 50, total: 1 },
    });

    await renderPage();

    expect(await screen.findAllByText("Cement")).toHaveLength(2); // table row + card
  });

  test("an empty catalog shows an empty state, not an error", async () => {
    mockListCatalog.mockResolvedValue({ data: [], meta: { page: 1, pageSize: 50, total: 0 } });

    await renderPage();

    expect(await screen.findByText("No materials in this catalog yet")).toBeTruthy();
  });

  test("a view-only user does not see the Add Material action", async () => {
    mockListCatalog.mockResolvedValue({ data: [], meta: { page: 1, pageSize: 50, total: 0 } });
    mockPermissions = new Set(["material_catalog.view"]);

    await renderPage();

    await screen.findByText("No materials in this catalog yet");
    expect(screen.queryByText("Add Material")).toBeNull();
  });

  test("a user with material_catalog.manage sees the Add Material action", async () => {
    mockListCatalog.mockResolvedValue({ data: [], meta: { page: 1, pageSize: 50, total: 0 } });
    mockPermissions = new Set(["material_catalog.view", "material_catalog.manage"]);

    await renderPage();

    expect(await screen.findByText("Add Material")).toBeTruthy();
  });

  test("a load failure renders the error state", async () => {
    mockListCatalog.mockRejectedValue(new ApiError(503, "SERVICE_UNAVAILABLE", "Network error"));

    await renderPage();

    expect(await screen.findByText("Network error")).toBeTruthy();
  });
});
