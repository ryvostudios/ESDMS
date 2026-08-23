import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { NavList } from "./NavList.jsx";

const authState = vi.hoisted(() => ({ permissions: new Set(), user: { employeeId: null } }));
vi.mock("../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({
    user: authState.user,
    hasPermission: (...codes) => codes.some((code) => authState.permissions.has(code)),
  }),
}));

describe("permission-driven Workforce navigation", () => {
  beforeEach(() => {
    authState.permissions = new Set();
    authState.user = { employeeId: null };
  });

  test("a Gate Guard sees no Workforce or governance navigation", () => {
    authState.permissions = new Set(["gate_pass.verify", "gate_pass.exit", "gate_pass.return"]);
    render(<MemoryRouter><NavList /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Gate" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Employees" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Reports" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Governance" })).toBeNull();
  });

  test("My Workforce requires both self-service permission and a linked Employee record", () => {
    authState.permissions = new Set(["profile.self.view"]);

    const { rerender } = render(<MemoryRouter><NavList /></MemoryRouter>);
    expect(screen.queryByRole("link", { name: "My Workforce" })).toBeNull();

    authState.user = { employeeId: "employee-1" };
    rerender(<MemoryRouter><NavList /></MemoryRouter>);

    expect(screen.getByRole("link", { name: "My Workforce" })).toBeTruthy();
  });

  test("reports require view and export while governance follows users.view", () => {
    authState.permissions = new Set(["employees.view", "workforce.reports.view", "users.view"]);
    const { rerender } = render(<MemoryRouter><NavList /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Employees" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Reports" })).toBeNull();
    expect(screen.getByRole("link", { name: "Governance" })).toBeTruthy();

    authState.permissions.add("workforce.export");
    rerender(<MemoryRouter><NavList /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Reports" })).toBeTruthy();
  });
});
