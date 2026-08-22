import { describe, test, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ProtectedRoute } from "./ProtectedRoute.jsx";

const mockUseAuth = vi.fn();
vi.mock("../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => mockUseAuth(),
}));

afterEach(() => {
  cleanup();
  mockUseAuth.mockReset();
});

function renderAt(path, status) {
  mockUseAuth.mockReturnValue({ status });

  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div>Login page</div>} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <div>Dashboard content</div>
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProtectedRoute", () => {
  test("shows a loading state while the session check is in flight", () => {
    renderAt("/dashboard", "loading");
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText("Dashboard content")).toBeNull();
  });

  test("redirects to /login when unauthenticated", () => {
    renderAt("/dashboard", "unauthenticated");
    expect(screen.getByText("Login page")).toBeTruthy();
    expect(screen.queryByText("Dashboard content")).toBeNull();
  });

  test("renders the protected content when authenticated", () => {
    renderAt("/dashboard", "authenticated");
    expect(screen.getByText("Dashboard content")).toBeTruthy();
  });
});
