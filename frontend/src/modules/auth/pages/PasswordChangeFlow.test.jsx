import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "../../../core/auth/AuthContext.jsx";
import { ProtectedRoute } from "../../../app/routing/ProtectedRoute.jsx";
import { LoginPage } from "./LoginPage.jsx";
import { ChangePasswordPage } from "./ChangePasswordPage.jsx";

vi.mock("./LoginMeshBackground.jsx", () => ({ LoginMeshBackground: () => null }));
vi.mock("./LoginKineticBackground.jsx", () => ({ LoginKineticBackground: () => null }));
vi.mock("../../../shared/components/MobileKineticBackground.jsx", () => ({ MobileKineticBackground: () => null }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Dashboard() {
  const { user, logout } = useAuth();
  return <><h1>Dashboard</h1><p>Required: {String(user.mustChangePassword)}</p><button onClick={logout}>Sign out</button></>;
}
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{JSON.stringify({ path: location.pathname, state: location.state })}</div>;
}
function setup({ required = true, initialPath = "/" } = {}) {
  let authenticated = false;
  let mustChangePassword = required;
  const user = () => ({ id: "employee-1", role: "EMPLOYEE", permissions: [], mustChangePassword });
  const response = (status, data) => ({ ok: status === 200, status, headers: { get: () => "application/json" }, json: async () => ({ success: status === 200, data }) });
  const fetchMock = vi.fn(async (url) => {
    if (url.endsWith("/auth/login")) { authenticated = true; return response(200, { user: user() }); }
    if (url.endsWith("/auth/change-password")) { mustChangePassword = false; authenticated = false; return response(200, { requiresLogin: true }); }
    if (url.endsWith("/auth/logout")) { authenticated = false; return response(200, null); }
    if (url.endsWith("/auth/me")) return response(authenticated ? 200 : 401, authenticated ? { user: user() } : null);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<AuthProvider><MemoryRouter initialEntries={[initialPath]}>
    <LocationProbe />
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute><Outlet /></ProtectedRoute>}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/change-password" element={<ChangePasswordPage />} />
        <Route path="/requested" element={<h1>Requested page</h1>} />
      </Route>
    </Routes>
  </MemoryRouter></AuthProvider>);
  return fetchMock;
}
async function signIn(password = "New-Password-12345!") {
  await screen.findByLabelText("Email", { exact: false });
  fireEvent.change(screen.getByLabelText("Email", { exact: false }), { target: { value: "employee@test.eset.local" } });
  fireEvent.change(screen.getByLabelText(/^Password\s*\*?$/), { target: { value: password } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign in" })));
}

test("forced change clears auth and navigates atomically: second and future logins reach Dashboard", async () => {
  const fetchMock = setup();
  await signIn("Temporary-Password-123!");
  await screen.findByRole("heading", { name: "Change your password" });
  fireEvent.change(screen.getByLabelText(/Current password/), { target: { value: "Temporary-Password-123!" } });
  fireEvent.change(screen.getByLabelText(/^New password/), { target: { value: "New-Password-12345!" } });
  fireEvent.change(screen.getByLabelText(/Confirm new password/), { target: { value: "New-Password-12345!" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Change password" })));
  await screen.findByRole("heading", { name: "Sign in" });
  const location = JSON.parse(screen.getByTestId("location").textContent);
  expect(location.state?.from?.pathname).not.toBe("/change-password");
  expect(screen.getByRole("status").textContent).toBe("Password changed. Sign in again.");
  await signIn();
  await screen.findByRole("heading", { name: "Dashboard" });
  expect(screen.getByText("Required: false")).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign out" })));
  await signIn();
  await screen.findByRole("heading", { name: "Dashboard" });
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/auth/change-password"))).toHaveLength(1);
});

test("ordinary false-flag login retains the requested protected destination", async () => {
  setup({ required: false, initialPath: "/requested" });
  await signIn();
  await screen.findByRole("heading", { name: "Requested page" });
  expect(screen.queryByRole("heading", { name: "Change your password" })).toBeNull();
});

test("an invalid/expired initial session still returns to login without protected content", async () => {
  setup({ required: false });
  await screen.findByRole("heading", { name: "Sign in" });
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Dashboard" })).toBeNull());
});
