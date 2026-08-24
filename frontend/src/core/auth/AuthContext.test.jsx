import { describe, test, expect, vi, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "./AuthContext.jsx";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AuthContext critical flow", () => {
  test("no existing session: settles to unauthenticated after checking /auth/me", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(401, { success: false, error: { code: "UNAUTHORIZED", message: "Unauthorized" } }),
      ),
    );

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });

    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("unauthenticated"));
    expect(result.current.user).toBeNull();
  });

  test("login success: sets the user and flips status to authenticated", async () => {
    const user = { id: "u1", role: "ADMIN", permissions: ["gate_pass.create"] };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url) => {
        if (String(url).includes("/auth/me")) {
          return Promise.resolve(jsonResponse(401, { success: false, error: {} }));
        }
        if (String(url).includes("/auth/login")) {
          return Promise.resolve(jsonResponse(200, { success: true, data: { token: "t", user } }));
        }
        throw new Error(`Unexpected fetch to ${url}`);
      }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.status).toBe("unauthenticated"));

    await act(async () => {
      await result.current.login("admin@example.com", "password");
    });

    expect(result.current.status).toBe("authenticated");
    expect(result.current.user).toEqual(user);
    expect(result.current.hasPermission("gate_pass.create")).toBe(true);
    expect(result.current.hasPermission("gate_pass.approve")).toBe(false);
  });

  test("login sends rememberMe as a boolean, defaulting to false when omitted", async () => {
    const user = { id: "u1", role: "ADMIN", permissions: [] };
    let capturedBody = null;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url, init) => {
        if (String(url).includes("/auth/me")) {
          return Promise.resolve(jsonResponse(401, { success: false, error: {} }));
        }
        if (String(url).includes("/auth/login")) {
          capturedBody = JSON.parse(init.body);
          return Promise.resolve(jsonResponse(200, { success: true, data: { token: "t", user } }));
        }
        throw new Error(`Unexpected fetch to ${url}`);
      }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.status).toBe("unauthenticated"));

    await act(async () => {
      await result.current.login("admin@example.com", "password");
    });

    expect(capturedBody.rememberMe).toBe(false);

    await act(async () => {
      await result.current.login("admin@example.com", "password", true);
    });

    expect(capturedBody.rememberMe).toBe(true);
  });

  test("logout: clears the user and returns to unauthenticated", async () => {
    const user = { id: "u1", role: "ADMIN", permissions: [] };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url) => {
        if (String(url).includes("/auth/me")) {
          return Promise.resolve(jsonResponse(200, { success: true, data: { user } }));
        }
        if (String(url).includes("/auth/logout")) {
          return Promise.resolve(jsonResponse(200, { success: true, data: null }));
        }
        throw new Error(`Unexpected fetch to ${url}`);
      }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.status).toBe("authenticated"));

    act(() => {
      result.current.logout();
    });

    await waitFor(() => expect(result.current.status).toBe("unauthenticated"));
    expect(result.current.user).toBeNull();
  });

  test("logout: a failed request (e.g. the backend's 503 when it couldn't confirm revocation) does NOT clear the session", async () => {
    const user = { id: "u1", role: "ADMIN", permissions: [] };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url) => {
        if (String(url).includes("/auth/me")) {
          return Promise.resolve(jsonResponse(200, { success: true, data: { user } }));
        }
        if (String(url).includes("/auth/logout")) {
          return Promise.resolve(
            jsonResponse(503, {
              success: false,
              error: { code: "SERVICE_UNAVAILABLE", message: "Could not securely sign out. Please try again." },
            }),
          );
        }
        throw new Error(`Unexpected fetch to ${url}`);
      }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.status).toBe("authenticated"));

    await act(async () => {
      await expect(result.current.logout()).rejects.toThrow("Could not securely sign out. Please try again.");
    });

    // The UI must keep showing the user as authenticated — a false
    // "logged out" state here would be misleading given the session may
    // still be live server-side.
    expect(result.current.status).toBe("authenticated");
    expect(result.current.user).toEqual(user);
  });
});
