import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GatePassForm } from "./GatePassForm.jsx";

vi.mock("../api.js", () => ({
  listDepartments: vi.fn(() => Promise.resolve({ data: [{ id: "dept-1", name: "Operations" }] })),
}));

const mockUser = { id: "u1", departmentId: "dept-1" };
let mockPermissions = new Set(["gate_pass.view_site"]);
vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({ user: mockUser, hasPermission: (code) => mockPermissions.has(code) }),
}));

afterEach(() => {
  cleanup();
  mockPermissions = new Set(["gate_pass.view_site"]);
});

async function renderForm(onSubmit = vi.fn()) {
  await act(async () => {
    render(<GatePassForm submitLabel="Save draft" onSubmit={onSubmit} />);
  });
  return onSubmit;
}

describe("GatePassForm items — mobile card structure and item management", () => {
  test("a single item renders with its index label, all four fields, and a disabled remove button", async () => {
    await renderForm();

    expect(screen.getByText("Item 1")).toBeTruthy();
    expect(screen.getByLabelText(/^description/i)).toBeTruthy();
    expect(screen.getByLabelText(/part number/i)).toBeTruthy();
    expect(screen.getByLabelText(/^quantity/i)).toBeTruthy();
    expect(screen.getByLabelText(/^unit/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove item 1" }).disabled).toBe(true);
  });

  test("Add item appends a second card with its own index and an enabled remove button", async () => {
    await renderForm();

    fireEvent.click(screen.getByRole("button", { name: /add item/i }));

    expect(screen.getByText("Item 1")).toBeTruthy();
    expect(screen.getByText("Item 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove item 1" }).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Remove item 2" }).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Remove item 2" }));
    expect(screen.queryByText("Item 2")).toBeNull();
  });

  test("Save draft and item fields remain reachable — submits the same item payload shape as before", async () => {
    const onSubmit = await renderForm();

    fireEvent.change(screen.getByLabelText(/issuing department/i), { target: { value: "dept-1" } });
    fireEvent.change(screen.getByLabelText(/requested by/i), { target: { value: "Ali" } });
    fireEvent.change(screen.getByLabelText(/issued to.*destination/i), { target: { value: "Warehouse" } });
    fireEvent.change(screen.getByLabelText(/driver name/i), { target: { value: "Bilal" } });
    fireEvent.change(screen.getByLabelText(/driver phone/i), { target: { value: "03001234567" } });
    fireEvent.change(screen.getByLabelText(/vehicle registration/i), { target: { value: "abc-123" } });
    fireEvent.change(screen.getByLabelText(/^purpose/i), { target: { value: "SALES" } });
    fireEvent.change(screen.getByLabelText(/^description/i), { target: { value: "Pump" } });
    fireEvent.change(screen.getByLabelText(/part number/i), { target: { value: "PN-1" } });
    fireEvent.change(screen.getByLabelText(/^quantity/i), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(/^unit/i), { target: { value: "pcs" } });

    expect(screen.getByRole("button", { name: "Save draft" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedBy: "Ali",
        destination: "Warehouse",
        items: [{ description: "Pump", partNumber: "PN-1", quantity: 2, unit: "pcs" }],
      }),
    );
  });
});
