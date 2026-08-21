import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../core/auth/AuthContext.jsx";
import { LoadingState } from "../../shared/components/StatePanel.jsx";

export function ProtectedRoute({ children }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return <LoadingState message="Checking your session…" />;
  }

  if (status === "unauthenticated") {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return children;
}
