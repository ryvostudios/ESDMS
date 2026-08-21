import { Routes, Route, Navigate } from "react-router-dom";
import { AppShell } from "../layout/AppShell.jsx";
import { ProtectedRoute } from "./ProtectedRoute.jsx";
import { PermissionRoute } from "./PermissionRoute.jsx";
import { LoginPage } from "../../modules/auth/pages/LoginPage.jsx";
import { DashboardPage } from "../../modules/gate-pass/pages/DashboardPage.jsx";
import { GatePassListPage } from "../../modules/gate-pass/pages/GatePassListPage.jsx";
import { GatePassDetailPage } from "../../modules/gate-pass/pages/GatePassDetailPage.jsx";
import { GatePassFormPage } from "../../modules/gate-pass/pages/GatePassFormPage.jsx";
import { ApprovalQueuePage } from "../../modules/gate-pass/pages/ApprovalQueuePage.jsx";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<DashboardPage />} />

        <Route
          path="/gate-passes"
          element={
            <PermissionRoute permissions={["gate_pass.view_own", "gate_pass.view_site"]}>
              <GatePassListPage />
            </PermissionRoute>
          }
        />
        <Route
          path="/gate-passes/new"
          element={
            <PermissionRoute permissions={["gate_pass.create"]}>
              <GatePassFormPage />
            </PermissionRoute>
          }
        />
        <Route
          path="/gate-passes/:id/edit"
          element={
            <PermissionRoute permissions={["gate_pass.edit_draft"]}>
              <GatePassFormPage />
            </PermissionRoute>
          }
        />
        <Route
          path="/gate-passes/:id"
          element={
            <PermissionRoute permissions={["gate_pass.view_own", "gate_pass.view_site"]}>
              <GatePassDetailPage />
            </PermissionRoute>
          }
        />
        <Route
          path="/approvals"
          element={
            <PermissionRoute permissions={["gate_pass.approve"]}>
              <ApprovalQueuePage />
            </PermissionRoute>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
