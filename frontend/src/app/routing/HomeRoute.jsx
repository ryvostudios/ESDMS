import { Navigate } from "react-router-dom";
import { useAuth } from "../../core/auth/AuthContext.jsx";
import { DashboardPage } from "../../modules/gate-pass/pages/DashboardPage.jsx";

// A Guard holds only verify/exit/return — never view_own/view_site — so the
// office Dashboard (which lists Gate Passes) isn't reachable for them. Send
// Guards straight to their own dashboard instead of a page they'd 403 on.
export function HomeRoute() {
  const { hasPermission } = useAuth();

  if (!hasPermission("gate_pass.view_own", "gate_pass.view_site") && hasPermission("gate_pass.verify")) {
    return <Navigate to="/guard" replace />;
  }

  return <DashboardPage />;
}
