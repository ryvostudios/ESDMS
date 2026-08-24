import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GovernancePage } from "./GovernancePage.jsx";

const mockListUsers = vi.hoisted(() => vi.fn());
const mockGetUserPermissions = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: { effectivePermissions: [], overrides: [] } })));
const mockActivateUser = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: null })));
const mockDeactivateUser = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: null })));
const mockRegenerateTempPassword = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: { temporaryPassword: "Abc123XYZ" } })));
const mockSetUserPermission = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: null })));
const mockRemoveUserPermission = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: null })));
const mockChangeUserRole = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: null })));

vi.mock("../api.js", () => ({
  listUsers: mockListUsers,
  getUserPermissions: mockGetUserPermissions,
  activateUser: mockActivateUser,
  deactivateUser: mockDeactivateUser,
  regenerateTempPassword: mockRegenerateTempPassword,
  setUserPermission: mockSetUserPermission,
  removeUserPermission: mockRemoveUserPermission,
  changeUserRole: mockChangeUserRole,
}));

let mockPermissions = new Set();
const actor = { id: "ceo-1", role: "CEO" };
function hasPermission(...codes) {
  return codes.some((code) => mockPermissions.has(code));
}
vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({ user: actor, hasPermission }),
}));

afterEach(() => {
  cleanup();
  mockListUsers.mockReset();
  mockGetUserPermissions.mockReset().mockResolvedValue({ data: { effectivePermissions: [], overrides: [] } });
  mockActivateUser.mockReset().mockResolvedValue({ data: null });
  mockDeactivateUser.mockReset().mockResolvedValue({ data: null });
  mockRegenerateTempPassword.mockReset().mockResolvedValue({ data: { temporaryPassword: "Abc123XYZ" } });
  mockSetUserPermission.mockReset().mockResolvedValue({ data: null });
  mockRemoveUserPermission.mockReset().mockResolvedValue({ data: null });
  mockChangeUserRole.mockReset().mockResolvedValue({ data: null });
  mockPermissions = new Set();
});

const HR_USER = { id: "u1", fullName: "Hana Rahim", email: "hana@test.eset.local", role: "HR", isActive: true };
const CEO_TARGET = { id: "ceo-2", fullName: "Other CEO", email: "ceo2@test.eset.local", role: "CEO", isActive: true };
const UM_USER = { id: "u2", fullName: "Uzma Malik", email: "uzma@test.eset.local", role: "UPPER_MANAGEMENT", isActive: true };

async function renderPage() {
  await act(async () => {
    render(<GovernancePage />);
  });
}

async function selectUser(name) {
  await act(async () => {
    fireEvent.click(screen.getAllByText(name)[0]);
  });
}

describe("GovernancePage user directory", () => {
  test("renders each user's identity, role, and status in both the table and mobile card", async () => {
    mockListUsers.mockResolvedValue({ data: [HR_USER] });
    await renderPage();

    expect(screen.getAllByText("Hana Rahim").length).toBe(2);
    expect(screen.getAllByText("hana@test.eset.local").length).toBe(2);
    // The KPI card also has a plain "Active" label, in addition to the
    // table row's and mobile card's status badges.
    expect(screen.getAllByText("Active").length).toBe(3);
  });
});

describe("GovernancePage protected-target behavior", () => {
  test("a CEO target shows no management actions, even for the CEO actor", async () => {
    mockPermissions = new Set(["users.activate", "users.deactivate", "users.update", "permission_overrides.manage", "users.regenerate_temp_password"]);
    mockListUsers.mockResolvedValue({ data: [CEO_TARGET] });
    await renderPage();
    await selectUser("Other CEO");

    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Regenerate temporary password" })).toBeNull();
    expect(screen.queryByLabelText("Role")).toBeNull();
  });

  test("an UPPER_MANAGEMENT target requires users.manage_um to be managed", async () => {
    mockPermissions = new Set(["users.activate", "users.deactivate"]);
    mockListUsers.mockResolvedValue({ data: [UM_USER] });
    await renderPage();
    await selectUser("Uzma Malik");

    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
  });
});

describe("GovernancePage credential / security-sensitive actions", () => {
  test("Regenerate temporary password is hidden without users.regenerate_temp_password", async () => {
    mockListUsers.mockResolvedValue({ data: [HR_USER] });
    await renderPage();
    await selectUser("Hana Rahim");

    expect(screen.queryByRole("button", { name: "Regenerate temporary password" })).toBeNull();
  });

  test("Regenerate temporary password shows the required confirmation text and a one-time reveal that can be dismissed", async () => {
    mockPermissions = new Set(["users.regenerate_temp_password"]);
    mockListUsers.mockResolvedValue({ data: [HR_USER] });
    await renderPage();
    await selectUser("Hana Rahim");

    fireEvent.click(screen.getByRole("button", { name: "Regenerate temporary password" }));
    expect(
      screen.getByText(
        "Generate a new temporary password for this first-login account. Any previous temporary credential/session will stop working.",
      ),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    });

    expect(mockRegenerateTempPassword).toHaveBeenCalledWith("u1");
    expect(screen.getByText("Abc123XYZ")).toBeTruthy();
    expect(screen.getByText(/will not be shown again/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Abc123XYZ")).toBeNull();
  });

  test("selecting a different user clears a previously revealed temporary password", async () => {
    mockPermissions = new Set(["users.regenerate_temp_password"]);
    mockListUsers.mockResolvedValue({ data: [HR_USER, { ...HR_USER, id: "u3", fullName: "Third User", email: "third@test.eset.local" }] });
    await renderPage();
    await selectUser("Hana Rahim");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Regenerate temporary password" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    });
    expect(screen.getByText("Abc123XYZ")).toBeTruthy();

    await selectUser("Third User");
    expect(screen.queryByText("Abc123XYZ")).toBeNull();
  });

  test("Deactivate requires confirmation before calling the API", async () => {
    mockPermissions = new Set(["users.deactivate"]);
    mockListUsers.mockResolvedValue({ data: [HR_USER] });
    await renderPage();
    await selectUser("Hana Rahim");

    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    expect(mockDeactivateUser).not.toHaveBeenCalled();
    expect(screen.getByText(/immediately lose access/i)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });

    expect(mockDeactivateUser).toHaveBeenCalledWith("u1");
  });
});

describe("GovernancePage permission overrides", () => {
  test("GRANT and DENY overrides render with distinct tones, and effective permissions call out granted ones", async () => {
    mockPermissions = new Set(["permission_overrides.manage"]);
    mockListUsers.mockResolvedValue({ data: [HR_USER] });
    mockGetUserPermissions.mockResolvedValue({
      data: {
        effectivePermissions: ["employees.view", "employees.create"],
        overrides: [
          { permissionCode: "employees.create", effect: "GRANT", reason: "Delegated" },
          { permissionCode: "gate_pass.approve", effect: "DENY", reason: "Restricted" },
        ],
      },
    });
    await renderPage();
    await selectUser("Hana Rahim");

    expect(await screen.findByText("employees.create · granted")).toBeTruthy();
    expect(screen.getAllByText("GRANT").length).toBeGreaterThan(0);
    expect(screen.getAllByText("DENY").length).toBeGreaterThan(0);
  });
});
