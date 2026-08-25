import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError } from "../../../core/api/client.js";
import { DemandListPage } from "./DemandListPage.jsx";

const mockListDemands = vi.hoisted(() => vi.fn());

vi.mock("../api.js", () => ({
  listDemands: (...args) => mockListDemands(...args),
}));

let mockPermissions = new Set();
vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({
    user: { departmentId: "dept-civil" },
    hasPermission: (...codes) => codes.some((code) => mockPermissions.has(code)),
  }),
}));

afterEach(() => {
  cleanup();
  mockListDemands.mockReset();
  mockPermissions = new Set();
});

async function renderPage() {
  await act(async () => {
    render(
      <MemoryRouter>
        <DemandListPage />
      </MemoryRouter>,
    );
  });
}

describe("DemandListPage", () => {
  test("renders Demand rows", async () => {
    mockListDemands.mockResolvedValue({
      data: [
        {
          id: "demand-1",
          demand_number: "DL-2026-000001",
          status: "DRAFT",
          department_name: "Civil",
          created_at: "2026-08-25T00:00:00.000Z",
        },
      ],
      meta: { page: 1, pageSize: 20, total: 1 },
    });

    await renderPage();

    expect(await screen.findAllByText("DL-2026-000001")).toHaveLength(2); // table row + card
  });

  test("an empty list shows an empty state, not an error", async () => {
    mockListDemands.mockResolvedValue({ data: [], meta: { page: 1, pageSize: 20, total: 0 } });

    await renderPage();

    expect(await screen.findByText("No Demands found")).toBeTruthy();
  });

  test("a load failure renders the error state", async () => {
    mockListDemands.mockRejectedValue(new ApiError(503, "SERVICE_UNAVAILABLE", "Network error"));

    await renderPage();

    expect(await screen.findByText("Network error")).toBeTruthy();
  });

  test("a user without demand.create does not see the New Demand action", async () => {
    mockListDemands.mockResolvedValue({ data: [], meta: { page: 1, pageSize: 20, total: 0 } });
    mockPermissions = new Set(["demand.view"]);

    await renderPage();

    await screen.findByText("No Demands found");
    expect(screen.queryByText("New Demand")).toBeNull();
  });

  test("a user with demand.create sees the New Demand action", async () => {
    mockListDemands.mockResolvedValue({ data: [], meta: { page: 1, pageSize: 20, total: 0 } });
    mockPermissions = new Set(["demand.view", "demand.create"]);

    await renderPage();

    expect(await screen.findByText("New Demand")).toBeTruthy();
  });
});
