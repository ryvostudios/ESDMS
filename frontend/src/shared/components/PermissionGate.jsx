import { useAuth } from "../../core/auth/AuthContext.jsx";

// Frontend permission checks are UX only — every backend endpoint enforces
// its own permission check independently. This just avoids showing a
// control the user cannot actually use.
export function PermissionGate({ permissions, children, fallback = null }) {
  const { hasPermission } = useAuth();
  return hasPermission(...permissions) ? children : fallback;
}
