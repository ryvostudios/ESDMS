import { describe, test, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Sidebar } from "./Sidebar.jsx";
import gridStyles from "./SidebarKineticBackground.module.css";

vi.mock("../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({ user: { employeeId: "employee-1" }, hasPermission: () => true }),
}));
vi.mock("../../modules/cms/company-logo.js", () => ({ useCompanyLogo: () => "blob:managed-logo" }));

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    setTransform: vi.fn(),
  });
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: true, // reduced motion: no RAF loop needed for this structural test
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete globalThis.ResizeObserver;
});

describe("Sidebar", () => {
  test("renders the kinetic grid canvas behind navigation, never intercepting clicks", () => {
    const { container } = render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    const canvas = container.querySelector("canvas");
    expect(canvas).toBeTruthy();
    expect(canvas.className).toContain(gridStyles.canvas);
    expect(container.querySelector('img')?.src).toContain('blob:managed-logo');
  });

  test("navigation remains real links, reachable by role", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Gate Passes" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
  });

  test("the active route link carries the active styling hook", () => {
    render(
      <MemoryRouter initialEntries={["/gate-passes"]}>
        <Sidebar />
      </MemoryRouter>,
    );

    const active = screen.getByRole("link", { name: "Gate Passes" });
    expect(active.className).toContain("navLinkActive");
  });

});
