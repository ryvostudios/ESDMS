import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { ChangePasswordPage } from "./ChangePasswordPage.jsx";
import { ApiError } from "../../../core/api/client.js";

const mockPost = vi.fn();
vi.mock("../../../core/api/client.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, apiClient: { post: (...args) => mockPost(...args) } };
});

const mockClearSession = vi.fn();
const mockRefreshUser = vi.fn();
vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({ clearSession: mockClearSession, refreshUser: mockRefreshUser }),
}));

afterEach(() => {
  cleanup();
  mockPost.mockReset();
  mockClearSession.mockReset();
  mockRefreshUser.mockReset();
});

// A minimal stand-in for the real LoginPage: renders exactly what
// ChangePasswordPage's navigation hands it, so tests assert on the actual
// integration contract (router state), not implementation details.
function LoginStub() {
  const location = useLocation();
  return <div>Login page{location.state?.info ? ` — ${location.state.info}` : ""}</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/change-password"]}>
      <Routes>
        <Route path="/login" element={<LoginStub />} />
        <Route path="/change-password" element={<ChangePasswordPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText(/current password/i), { target: { value: "OldPassword123!" } });
  fireEvent.change(screen.getByLabelText(/^new password/i), { target: { value: "NewPassword123!" } });
  fireEvent.change(screen.getByLabelText(/confirm new password/i), { target: { value: "NewPassword123!" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));
  });
}

describe("ChangePasswordPage — ESDMS-020 post-success behavior", () => {
  test("successful change signs the user out locally and navigates to the login screen", async () => {
    mockPost.mockResolvedValue({ success: true, data: { requiresLogin: true } });
    renderPage();

    await fillAndSubmit();

    expect(screen.getByText(/login page/i)).toBeTruthy();
    expect(mockClearSession).toHaveBeenCalledTimes(1);
  });

  test("does not call refreshUser (which would hit /auth/me and surface its expected 401)", async () => {
    mockPost.mockResolvedValue({ success: true, data: { requiresLogin: true } });
    renderPage();

    await fillAndSubmit();

    expect(mockRefreshUser).not.toHaveBeenCalled();
  });

  test("presents the success message on the screen the user is navigated to", async () => {
    mockPost.mockResolvedValue({ success: true, data: { requiresLogin: true } });
    renderPage();

    await fillAndSubmit();

    expect(screen.getByText("Password changed. Sign in again.", { exact: false })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a backend validation/error response leaves the user on the form with the real error, no session change", async () => {
    mockPost.mockRejectedValue(new ApiError(401, "UNAUTHORIZED", "Current password is incorrect."));
    renderPage();

    await fillAndSubmit();

    expect(screen.getByRole("alert").textContent).toMatch(/current password is incorrect/i);
    expect(screen.queryByText(/login page/i)).toBeNull();
    expect(mockClearSession).not.toHaveBeenCalled();
    expect(mockRefreshUser).not.toHaveBeenCalled();
  });

  test("no stale authenticated state remains after success (clearSession is the only state transition)", async () => {
    mockPost.mockResolvedValue({ success: true, data: { requiresLogin: true } });
    renderPage();

    await fillAndSubmit();

    expect(mockClearSession).toHaveBeenCalledTimes(1);
    expect(mockRefreshUser).not.toHaveBeenCalled();
  });
});
