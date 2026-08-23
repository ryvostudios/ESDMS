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

  // Re-fetches /auth/me without a full page reload — used after an action
  // that changes the current session's own profile server-side but not
  // its cookie (e.g. change-password clearing mustChangePassword).
  const refreshUser = useCallback(async () => {
    const response = await apiClient.get("/auth/me", { suppressUnauthorizedHandling: true });
    setUser(response.data.user);
  }, []);

  // Exposed for a caller that already knows, from its own response, that
  // the session is dead server-side (e.g. change-password — see
  // docs/DECISIONS.md's ESDMS-020 entry) — clears local state directly,
  // with no network round-trip, instead of misusing logout() (which POSTs
  // to /auth/logout for a session there is nothing left to revoke) or
  // refreshUser() (which would call /auth/me and surface its 401 as if it
  // were a real error).
  const value = useMemo(
    () => ({ user, status, login, logout, hasPermission, refreshUser, clearSession }),
    [user, status, login, logout, hasPermission, refreshUser, clearSession],
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
