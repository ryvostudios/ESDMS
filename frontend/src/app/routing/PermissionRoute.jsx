import { Navigate } from "react-router-dom";
import { useAuth } from "../../core/auth/AuthContext.jsx";

// Route-level guard, not just a hidden nav link — a user who guesses a URL
// for an action they don't hold is redirected, not shown a broken page.
// The backend independently enforces the same permission on every request
// regardless of what the frontend does here.
export function PermissionRoute({ permissions, requireAll = false, children }) {
  const { hasPermission } = useAuth();
  const allowed = requireAll ? permissions.every((permission) => hasPermission(permission)) : hasPermission(...permissions);
  return allowed ? children : <Navigate to="/" replace />;
}
