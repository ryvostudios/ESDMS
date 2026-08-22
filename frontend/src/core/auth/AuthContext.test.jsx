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
});
