import { cleanup, render, screen } from "@testing-library/react";
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
    // This file renders without a global auto-cleanup, so a prior test's tree
    // would otherwise still be in the document and duplicate every link.
    cleanup();
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

  test("My Workforce requires only a linked Employee record — not profile.self.view (ESDMS-018)", () => {
    // No linked Employee at all: hidden regardless of permissions.
    authState.permissions = new Set(["profile.self.view"]);
    const { rerender } = render(<MemoryRouter><NavList /></MemoryRouter>);
    expect(screen.queryByRole("link", { name: "My Workforce" })).toBeNull();

    // Linked Employee, but NO profile.self.view at all — Documents/
    // Rotation/Contracts/Compensation need no permission, so the shell
    // must still be reachable.
    authState.permissions = new Set(["leave.self.view"]);
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

  test("Procurement navigation requires pricing authority, not ADMIN-like or price-view-only access", () => {
    authState.permissions = new Set(["users.view", "procurement.view_prices"]);
    const { rerender } = render(<MemoryRouter><NavList /></MemoryRouter>);
    expect(screen.queryByRole("link", { name: "Procurement" })).toBeNull();

    authState.permissions.add("procurement.pricing");
    rerender(<MemoryRouter><NavList /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Procurement" })).toBeTruthy();
  });

  test("IPO, Receiving and History navigation follow their own capabilities, not price authority", () => {
    // A department Team Lead: operational IPO/receiving visibility, no
    // financial capability of any kind.
    authState.permissions = new Set(["ipo.view", "receiving.view", "dc.view"]);
    const { rerender } = render(<MemoryRouter><NavList /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "IPOs" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Receiving" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Procurement" })).toBeNull();

    // Gate Guard gains nothing from this phase.
    authState.permissions = new Set(["gate_pass.verify", "gate_pass.exit", "gate_pass.return"]);
    rerender(<MemoryRouter><NavList /></MemoryRouter>);
    expect(screen.queryByRole("link", { name: "IPOs" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Receiving" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Procurement History" })).toBeNull();

    authState.permissions = new Set(["procurement.export"]);
    rerender(<MemoryRouter><NavList /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Procurement History" })).toBeTruthy();
  });
});
