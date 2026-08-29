import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkforceConfigPage } from "./WorkforceConfigPage.jsx";

const mockListDepartments = vi.hoisted(() => vi.fn());
const mockCreateDepartment = vi.hoisted(() => vi.fn());
const mockUpdateDepartment = vi.hoisted(() => vi.fn());
const mockArchiveDepartment = vi.hoisted(() => vi.fn());
const mockListPositions = vi.hoisted(() => vi.fn());
const mockCreatePosition = vi.hoisted(() => vi.fn());
const mockUpdatePosition = vi.hoisted(() => vi.fn());

vi.mock("../api.js", () => ({
  listDepartmentsManage: mockListDepartments,
  createDepartment: mockCreateDepartment,
  updateDepartment: mockUpdateDepartment,
  archiveDepartment: mockArchiveDepartment,
  listPositionsManage: mockListPositions,
  createPosition: mockCreatePosition,
  updatePosition: mockUpdatePosition,
}));

vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({
    hasPermission: (...codes) => codes.some((code) => new Set(["departments.manage", "positions.manage"]).has(code)),
  }),
}));

beforeEach(() => {
  mockListDepartments.mockResolvedValue({ data: [{ id: "d1", name: "Civil", is_active: true }] });
  mockListPositions.mockResolvedValue({ data: [{ id: "p1", code: "TL", name: "Team Lead", is_active: false }] });
  mockCreateDepartment.mockResolvedValue({ data: {} });
  mockUpdateDepartment.mockResolvedValue({ data: {} });
  mockArchiveDepartment.mockResolvedValue({ data: {} });
  mockCreatePosition.mockResolvedValue({ data: {} });
  mockUpdatePosition.mockResolvedValue({ data: {} });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderPage() {
  await act(async () => render(<WorkforceConfigPage />));
}

describe("Workforce configuration lifecycle controls", () => {
  test("Department supports edit and confirmed archive", async () => {
    await renderPage();

    const departmentHeading = screen.getByRole("heading", { name: "Departments" });
    const section = departmentHeading.closest("section");
    fireEvent.click(within(section).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(section).getByLabelText("Department name for Civil"), { target: { value: "Civil Works" } });
    await act(async () => fireEvent.click(within(section).getByRole("button", { name: "Save" })));
    expect(mockUpdateDepartment).toHaveBeenCalledWith("d1", { name: "Civil Works" });

    fireEvent.click(within(section).getByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/existing history is preserved/i)).toBeTruthy();
    expect(mockArchiveDepartment).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Archive" })));
    expect(mockArchiveDepartment).toHaveBeenCalledWith("d1", false);
  });

  test("Position supports edit and confirmed reactivation", async () => {
    await renderPage();
    const section = screen.getByRole("heading", { name: "Positions" }).closest("section");

    fireEvent.click(within(section).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(section).getByLabelText("Position name for TL"), { target: { value: "Administration Team Lead" } });
    await act(async () => fireEvent.click(within(section).getByRole("button", { name: "Save" })));
    expect(mockUpdatePosition).toHaveBeenCalledWith("p1", { name: "Administration Team Lead" });

    fireEvent.click(within(section).getByRole("button", { name: "Reactivate" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/available for new assignments again/i)).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Reactivate" })));
    await waitFor(() => expect(mockUpdatePosition).toHaveBeenLastCalledWith("p1", { isActive: true }));
  });
});
