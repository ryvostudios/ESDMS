import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LoginPage } from "./LoginPage.jsx";
import { ApiError } from "../../../core/api/client.js";

// The mesh/grid backgrounds are decorative canvases with their own
// dedicated test files (LoginMeshBackground.test.jsx,
// LoginKineticBackground.test.jsx) — stubbed here so these tests focus on
// the form, and so jsdom's lack of a real canvas/matchMedia implementation
// doesn't leak into unrelated assertions.
vi.mock("./LoginMeshBackground.jsx", () => ({
  LoginMeshBackground: () => null,
}));
vi.mock("./LoginKineticBackground.jsx", () => ({
  LoginKineticBackground: () => null,
}));

const mockLogin = vi.fn();
vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({ status: "unauthenticated", login: (...args) => mockLogin(...args) }),
}));

afterEach(() => {
  cleanup();
  mockLogin.mockReset();
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <LoginPage />
    </MemoryRouter>,
  );
}

describe("LoginPage — visual/structural", () => {
  test("renders the E-Set title", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: /e-set digital management system/i })).toBeTruthy();
  });
});

describe("LoginPage — Show/Hide password", () => {
  test("password field defaults to type=password", () => {
    renderPage();
    expect(screen.getByLabelText(/^password/i).type).toBe("password");
  });

  test("toggle button is accessible and switches type/label/aria-pressed, then back", () => {
    renderPage();
    const toggle = screen.getByRole("button", { name: /show password/i });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggle);

    expect(screen.getByLabelText(/^password/i).type).toBe("text");
    const hideToggle = screen.getByRole("button", { name: /hide password/i });
    expect(hideToggle.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(hideToggle);

    expect(screen.getByLabelText(/^password/i).type).toBe("password");
    expect(screen.getByRole("button", { name: /show password/i }).getAttribute("aria-pressed")).toBe("false");
  });

  test("toggling visibility never changes the entered value", () => {
    renderPage();
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "Secret123!" } });

    fireEvent.click(screen.getByRole("button", { name: /show password/i }));

    expect(screen.getByLabelText(/^password/i).value).toBe("Secret123!");
  });
});

describe("LoginPage — Remember me", () => {
  function fillCredentials() {
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "user@test.eset.local" } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "Password123!" } });
  }

  test("checkbox defaults unchecked", () => {
    renderPage();
    expect(screen.getByRole("checkbox", { name: /keep me signed in for 7 days/i }).checked).toBe(false);
  });

  test("submitting unchecked sends rememberMe: false", async () => {
    mockLogin.mockResolvedValue(undefined);
    renderPage();
    fillCredentials();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    });

    expect(mockLogin).toHaveBeenCalledWith("user@test.eset.local", "Password123!", false);
  });

  test("checking the box and submitting sends rememberMe: true", async () => {
    mockLogin.mockResolvedValue(undefined);
    renderPage();
    fillCredentials();
    fireEvent.click(screen.getByRole("checkbox", { name: /keep me signed in for 7 days/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    });

    expect(mockLogin).toHaveBeenCalledWith("user@test.eset.local", "Password123!", true);
  });
});

describe("LoginPage — existing login behavior preserved", () => {
  test("a failed login (ApiError) surfaces the message and does not crash", async () => {
    mockLogin.mockRejectedValue(new ApiError(401, "UNAUTHORIZED", "Invalid email or password."));
    renderPage();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "user@test.eset.local" } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "wrong" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    });

    expect(screen.getByRole("alert").textContent).toMatch(/invalid email or password/i);
  });

  test("empty fields are blocked client-side and never call login", async () => {
    renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    });

    expect(mockLogin).not.toHaveBeenCalled();
    expect(screen.getByText(/email is required/i)).toBeTruthy();
  });
});
