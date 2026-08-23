import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../core/auth/AuthContext.jsx";
import { LoadingState } from "../../shared/components/StatePanel.jsx";

export function ProtectedRoute({ children }) {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return <LoadingState message="Checking your session…" />;
  }

  if (status === "unauthenticated") {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  // Mirrors the backend's own requirePermission/requirePasswordChanged
  // gate (see docs/DECISIONS.md) — a forced first-login password change
  // blocks every other screen until it's done. The backend enforces this
  // independently regardless of what the frontend does here.
  if (user?.mustChangePassword && location.pathname !== "/change-password") {
    return <Navigate to="/change-password" replace />;
  }

  return children;
}
