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

let mockDepartments = [];
vi.mock("../../workforce/api.js", () => ({
  listDepartmentsManage: () => Promise.resolve({ data: mockDepartments }),
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
  mockDepartments = [];
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

describe("Add Material availability", () => {
  const addButton = () => screen.queryByRole("button", { name: "Add Material" });

  test("a Team Lead with material_catalog.manage can add in their own department", async () => {
    mockPermissions = new Set(["material_catalog.view", "material_catalog.manage"]);
    mockUser = { departmentId: "dept-civil" };
    mockListCatalog.mockResolvedValue({ data: [], meta: { total: 0 } });
    await renderPage();

    expect(addButton()).toBeTruthy();
    expect(addButton().disabled).toBe(false);
  });

  test("a company-wide actor with no department of their own is still able to add", async () => {
    // CEO: departmentId is null and the filter defaults to "All departments",
    // which used to leave this button permanently greyed out.
    mockPermissions = new Set([
      "material_catalog.view",
      "material_catalog.manage",
      "material_catalog.all_departments",
    ]);
    mockUser = { departmentId: null };
    mockDepartments = [{ id: "dept-civil", name: "Civil" }];
    mockListCatalog.mockResolvedValue({ data: [], meta: { total: 0 } });
    await renderPage();

    expect(addButton()).toBeTruthy();
    expect(addButton().disabled).toBe(false);
  });

  test("a company-wide actor with nothing to choose from is told why", async () => {
    mockPermissions = new Set([
      "material_catalog.view",
      "material_catalog.manage",
      "material_catalog.all_departments",
    ]);
    mockUser = { departmentId: null };
    mockDepartments = [];
    mockListCatalog.mockResolvedValue({ data: [], meta: { total: 0 } });
    await renderPage();

    expect(addButton().disabled).toBe(true);
    expect(addButton().getAttribute("title")).toMatch(/not assigned to a department/i);
  });

  test("a view-only actor is never offered the action at all", async () => {
    mockPermissions = new Set(["material_catalog.view"]);
    mockUser = { departmentId: "dept-civil" };
    mockListCatalog.mockResolvedValue({ data: [], meta: { total: 0 } });
    await renderPage();

    expect(addButton()).toBeNull();
  });
});
