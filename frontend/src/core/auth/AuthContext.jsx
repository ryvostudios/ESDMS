import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiClient, configureApiClient } from "../api/client.js";

const AuthContext = createContext(null);

// sessionStorage (not localStorage) so a reload survives within the same
// tab but the token never persists once the tab/browser closes — see
// docs/DECISIONS.md ("JWT Bearer Auth Kept; Storage Strategy Hardened").
const SESSION_KEY = "esdms.session.token";

export function AuthProvider({ children }) {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  // 'loading' only while a stored token still needs server verification;
  // computed lazily so there is no stored token, we start unauthenticated
  // immediately instead of setting state from inside an effect.
  const [status, setStatus] = useState(() =>
    sessionStorage.getItem(SESSION_KEY) ? "loading" : "unauthenticated",
  );

  const applySession = useCallback((nextToken, nextUser) => {
    sessionStorage.setItem(SESSION_KEY, nextToken);
    setToken(nextToken);
    setUser(nextUser);
    setStatus("authenticated");
  }, []);

  const clearSession = useCallback(() => {
    sessionStorage.removeItem(SESSION_KEY);
    setToken(null);
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  useEffect(() => {
    configureApiClient({ getToken: () => token, onUnauthorized: clearSession });
  }, [token, clearSession]);

  useEffect(() => {
    const stored = sessionStorage.getItem(SESSION_KEY);

    if (!stored) {
      return;
    }

    // Never trust a stored token blindly — verify it against the server
    // before treating the session as active.
    apiClient
      .get("/auth/me", { token: stored, suppressUnauthorizedHandling: true })
      .then((response) => applySession(stored, response.data.user))
      .catch(() => clearSession());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(
    async (email, password) => {
      const response = await apiClient.post(
        "/auth/login",
        { email, password },
        { suppressUnauthorizedHandling: true },
      );
      applySession(response.data.token, response.data.user);
    },
    [applySession],
  );

  const logout = useCallback(() => {
    clearSession();
  }, [clearSession]);

  const hasPermission = useCallback(
    (...codes) => Boolean(user) && codes.some((code) => user.permissions.includes(code)),
    [user],
  );

  const value = useMemo(
    () => ({ token, user, status, login, logout, hasPermission }),
    [token, user, status, login, logout, hasPermission],
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
