import { Navigate } from "react-router-dom";
import { useAuth } from "../../core/auth/AuthContext.jsx";
import { DashboardPage } from "../../modules/gate-pass/pages/DashboardPage.jsx";

// A Guard holds only verify/exit/return — never view_own/view_site — so the
// office Dashboard (which lists Gate Passes) isn't reachable for them. Send
// Guards straight to their own dashboard instead of a page they'd 403 on.
// Likewise, a Workforce-only user (EMPLOYEE, or HR/UM/CEO with no Gate Pass
// access) has no Gate Pass permission at all — send them to their
// Workforce home instead of an empty/unauthorized Gate Pass dashboard.
export function HomeRoute() {
  const { hasPermission } = useAuth();

  const hasGatePassOffice = hasPermission("gate_pass.view_own", "gate_pass.view_site");
  const hasGuard = hasPermission("gate_pass.verify", "gate_pass.exit", "gate_pass.return");

  if (!hasGatePassOffice && hasGuard) {
    return <Navigate to="/guard" replace />;
  }

  if (!hasGatePassOffice && !hasGuard) {
    if (hasPermission("employees.view")) return <Navigate to="/workforce/employees" replace />;
    if (hasPermission("profile.self.view")) return <Navigate to="/workforce/me" replace />;
  }

  return <DashboardPage />;
}
