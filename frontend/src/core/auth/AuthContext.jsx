import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiClient, configureApiClient } from "../api/client.js";

const AuthContext = createContext(null);

// Auth lives entirely in the HttpOnly Secure session cookie the backend
// sets on login — this client never stores or attaches a token itself
// (fetch calls carry it via credentials: "include"). On mount, the only
// way to know whether a session exists is to ask the server.
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState("loading");

  const clearSession = useCallback(() => {
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  useEffect(() => {
    configureApiClient({ onUnauthorized: clearSession });
  }, [clearSession]);

  useEffect(() => {
    apiClient
      .get("/auth/me", { suppressUnauthorizedHandling: true })
      .then((response) => {
        setUser(response.data.user);
        setStatus("authenticated");
      })
      .catch(() => clearSession());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(async (email, password) => {
    const response = await apiClient.post(
      "/auth/login",
      { email, password },
      { suppressUnauthorizedHandling: true },
    );
    setUser(response.data.user);
    setStatus("authenticated");
  }, []);

  // Only clears local session state on a CONFIRMED server-side logout — a
  // failed request (network error, or the backend's own 503 when it
  // couldn't confirm session revocation — see docs/SECURITY.md) must not
  // make the UI claim the user is logged out while their session may
  // still be live server-side. Callers should catch and surface the
  // rejection (see TopBar.jsx) rather than treating this as fire-and-forget.
  const logout = useCallback(async () => {
    await apiClient.post("/auth/logout", undefined, { suppressUnauthorizedHandling: true });
    clearSession();
  }, [clearSession]);

  const hasPermission = useCallback(
    (...codes) => Boolean(user) && codes.some((code) => user.permissions.includes(code)),
    [user],
  );

  const value = useMemo(
    () => ({ user, status, login, logout, hasPermission }),
    [user, status, login, logout, hasPermission],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// Standard pattern for context modules: the hook lives alongside its provider.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider.");
  }

  return context;
}
