import { Routes, Route, Navigate } from "react-router-dom";
import { AppShell } from "../layout/AppShell.jsx";
import { ProtectedRoute } from "./ProtectedRoute.jsx";
import { PermissionRoute } from "./PermissionRoute.jsx";
import { HomeRoute } from "./HomeRoute.jsx";
import { LoginPage } from "../../modules/auth/pages/LoginPage.jsx";
import { GatePassListPage } from "../../modules/gate-pass/pages/GatePassListPage.jsx";
import { GatePassDetailPage } from "../../modules/gate-pass/pages/GatePassDetailPage.jsx";
import { GatePassFormPage } from "../../modules/gate-pass/pages/GatePassFormPage.jsx";
import { ApprovalQueuePage } from "../../modules/gate-pass/pages/ApprovalQueuePage.jsx";
import { GuardDashboardPage } from "../../modules/guard/pages/GuardDashboardPage.jsx";
import { GuardVerifyPage } from "../../modules/guard/pages/GuardVerifyPage.jsx";
import { GuardActionPage } from "../../modules/guard/pages/GuardActionPage.jsx";

const GUARD_PERMISSIONS = ["gate_pass.verify", "gate_pass.exit", "gate_pass.return"];

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
        <Route path="/" element={<HomeRoute />} />

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

        <Route
          path="/guard"
          element={
            <PermissionRoute permissions={GUARD_PERMISSIONS}>
              <GuardDashboardPage />
            </PermissionRoute>
          }
        />
        <Route
          path="/guard/verify/:token"
          element={
            <PermissionRoute permissions={GUARD_PERMISSIONS}>
              <GuardVerifyPage />
            </PermissionRoute>
          }
        />
        <Route
          path="/guard/gate-passes/:id"
          element={
            <PermissionRoute permissions={GUARD_PERMISSIONS}>
              <GuardActionPage />
            </PermissionRoute>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
