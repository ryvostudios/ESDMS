import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { NotFoundPage } from "./NotFoundPage.jsx";
import { AccessDeniedPage } from "./AccessDeniedPage.jsx";
import { PermissionRoute } from "./PermissionRoute.jsx";

const mockNavigate = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual("react-router-dom")),
  useNavigate: () => mockNavigate,
}));

let mockPermissions = new Set();
vi.mock("../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({ hasPermission: (...codes) => codes.some((code) => mockPermissions.has(code)) }),
}));

afterEach(() => {
  cleanup();
  mockNavigate.mockReset();
  mockPermissions = new Set();
});

async function renderAt(ui) {
  await act(async () => render(<MemoryRouter>{ui}</MemoryRouter>));
}

describe("error routes", () => {
  test("an unmatched route renders a real not-found page", async () => {
    await renderAt(<Routes><Route path="/known" element={<p>known</p>} /><Route path="*" element={<NotFoundPage />} /></Routes>);
    expect(screen.getAllByText("Page not found").length).toBeGreaterThan(0);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test("a forbidden route renders access denied without redirecting", async () => {
    await renderAt(<PermissionRoute permissions={["users.view"]}><p>governance</p></PermissionRoute>);
    expect(screen.getByText("You don't have permission to access this page")).toBeTruthy();
    expect(screen.queryByText("governance")).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test("authorized content and requireAll behavior are preserved", async () => {
    mockPermissions = new Set(["users.view"]);
    await renderAt(<PermissionRoute permissions={["users.view"]}><p>allowed</p></PermissionRoute>);
    expect(screen.getByText("allowed")).toBeTruthy();
    cleanup();
    await renderAt(<PermissionRoute permissions={["users.view", "users.create"]} requireAll><p>blocked</p></PermissionRoute>);
    expect(screen.queryByText("blocked")).toBeNull();
  });

  test("error pages offer a safe return action", async () => {
    await renderAt(<AccessDeniedPage />);
    fireEvent.click(screen.getByRole("button", { name: "Go to Dashboard" }));
    expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
  });
});
