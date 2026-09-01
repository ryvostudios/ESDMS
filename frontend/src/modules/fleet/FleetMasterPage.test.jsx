import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FleetMasterPage } from "./FleetMasterPage.jsx";
import { DRIVER_CONFIG, VEHICLE_CONFIG } from "./fleet-configs.js";

const mockListDrivers = vi.hoisted(() => vi.fn());
const mockCreateDriver = vi.hoisted(() => vi.fn());
const mockUpdateDriver = vi.hoisted(() => vi.fn());
const mockListVehicles = vi.hoisted(() => vi.fn());

vi.mock("./api.js", () => ({
  listDrivers: (...args) => mockListDrivers(...args),
  createDriver: (...args) => mockCreateDriver(...args),
  updateDriver: (...args) => mockUpdateDriver(...args),
  listVehicles: (...args) => mockListVehicles(...args),
  createVehicle: vi.fn(),
  updateVehicle: vi.fn(),
}));

let mockPermissions;

vi.mock("../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({ hasPermission: (code) => mockPermissions.has(code) }),
}));

function driverRow(overrides = {}) {
  return {
    id: "driver-1",
    name: "Test Driver",
    phone: "0300-1111111",
    company: "Acme",
    driver_type: "CONTRACTOR",
    licence_number: "LIC-1",
    is_active: true,
    ...overrides,
  };
}

beforeEach(() => {
  mockPermissions = new Set(["driver.view", "driver.manage"]);
  mockListDrivers.mockResolvedValue({ data: [driverRow()] });
  mockListVehicles.mockResolvedValue({ data: [] });
  mockCreateDriver.mockResolvedValue({ data: {} });
  mockUpdateDriver.mockResolvedValue({ data: {} });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderDrivers() {
  await act(async () => render(<FleetMasterPage config={DRIVER_CONFIG} />));
}

// The page renders the same rows twice — a table for desktop and a card list
// for phones, the convention MaterialCatalogPage already uses. CSS decides
// which one is visible; jsdom has both, so assertions scope to one of them.
function inTable() {
  return within(screen.getByRole("table"));
}

function inCards() {
  return within(screen.getByRole("list"));
}

describe("Fleet master lifecycle", () => {
  test("lists drivers and offers add, edit and deactivate to a manager", async () => {
    await renderDrivers();

    expect(inTable().getByText("Test Driver")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Driver" })).toBeTruthy();
    expect(inTable().getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(inTable().getByRole("button", { name: "Deactivate" })).toBeTruthy();

    // The phone layout carries the same row and the same actions, so a narrow
    // viewport never loses the Actions column off the side of the page.
    expect(inCards().getByText("Test Driver")).toBeTruthy();
    expect(inCards().getByRole("button", { name: "Deactivate" })).toBeTruthy();
  });

  test("deactivation is confirmed first and never deletes", async () => {
    await renderDrivers();

    fireEvent.click(inTable().getByRole("button", { name: "Deactivate" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Existing Gate Pass history is never changed/i)).toBeTruthy();
    expect(mockUpdateDriver).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Deactivate" }));
    });
    await waitFor(() => expect(mockUpdateDriver).toHaveBeenCalledWith("driver-1", { isActive: false }));
  });

  test("an inactive driver is reachable only via Show inactive, and can be reactivated", async () => {
    mockListDrivers.mockResolvedValue({ data: [driverRow({ is_active: false })] });
    await renderDrivers();

    expect(inTable().getByText("Inactive")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Show inactive/i, { selector: "input" }));
    });
    await waitFor(() =>
      expect(mockListDrivers).toHaveBeenLastCalledWith(expect.objectContaining({ includeInactive: "true" })),
    );

    fireEvent.click(inTable().getByRole("button", { name: "Reactivate" }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Reactivate" }));
    });
    await waitFor(() => expect(mockUpdateDriver).toHaveBeenCalledWith("driver-1", { isActive: true }));
  });

  test("a view-only holder gets no add, edit or lifecycle control", async () => {
    mockPermissions = new Set(["driver.view"]);
    await renderDrivers();

    expect(screen.queryByRole("button", { name: "Add Driver" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
    // Neither layout leaks a management control to a view-only holder.
    expect(inCards().queryByRole("button", { name: "Deactivate" })).toBeNull();
  });

  test("the same page drives Vehicles from its own config", async () => {
    mockListVehicles.mockResolvedValue({
      data: [{ id: "v1", registration_number: "ABC-123", vehicle_type: "TRUCK", is_active: true }],
    });
    mockPermissions = new Set(["vehicle.view", "vehicle.manage"]);

    await act(async () => render(<FleetMasterPage config={VEHICLE_CONFIG} />));

    expect(inTable().getByText("ABC-123")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Vehicle" })).toBeTruthy();
  });
});
