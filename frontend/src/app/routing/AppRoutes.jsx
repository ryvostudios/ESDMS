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
import { ChangePasswordPage } from "../../modules/auth/pages/ChangePasswordPage.jsx";
import { MyWorkforcePage } from "../../modules/workforce/pages/MyWorkforcePage.jsx";
import { EmployeesListPage } from "../../modules/workforce/pages/EmployeesListPage.jsx";
import { AddEmployeePage } from "../../modules/workforce/pages/AddEmployeePage.jsx";
import { EmployeeDetailPage } from "../../modules/workforce/pages/EmployeeDetailPage.jsx";
import { WorkforceConfigPage } from "../../modules/workforce/pages/WorkforceConfigPage.jsx";
import { WorkforceDashboardPage } from "../../modules/workforce/pages/WorkforceDashboardPage.jsx";
import { WorkforceReportsPage } from "../../modules/workforce/pages/WorkforceReportsPage.jsx";
import { WorkforceOperationsPage } from "../../modules/workforce/pages/WorkforceOperationsPage.jsx";
import { GovernancePage } from "../../modules/workforce/pages/GovernancePage.jsx";

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
        <Route path="/change-password" element={<ChangePasswordPage />} />
        <Route path="/workforce" element={<PermissionRoute permissions={["employees.view"]}><WorkforceDashboardPage /></PermissionRoute>} />

        <Route
          path="/workforce/me"
          element={
            <PermissionRoute permissions={["profile.self.view"]}>
              <MyWorkforcePage />
            </PermissionRoute>
          }
        />
        <Route
          path="/workforce/employees"
          element={
            <PermissionRoute permissions={["employees.view"]}>
              <EmployeesListPage />
            </PermissionRoute>
          }
        />
        <Route
          path="/workforce/employees/new"
          element={
            <PermissionRoute permissions={["employees.create"]}>
              <AddEmployeePage />
            </PermissionRoute>
          }
        />
        <Route
          path="/workforce/employees/:id"
          element={
            <PermissionRoute permissions={["employees.view"]}>
              <EmployeeDetailPage />
            </PermissionRoute>
          }
        />
        <Route
          path="/workforce/config"
          element={
            <PermissionRoute permissions={["workforce.configuration.manage", "departments.manage", "positions.manage"]}>
              <WorkforceConfigPage />
            </PermissionRoute>
          }
        />
        <Route path="/workforce/operations" element={<PermissionRoute permissions={["leave.approve", "employee_documents.view", "rotation.adjust"]}><WorkforceOperationsPage /></PermissionRoute>} />
        <Route path="/workforce/reports" element={<PermissionRoute permissions={["workforce.reports.view", "workforce.export"]} requireAll><WorkforceReportsPage /></PermissionRoute>} />
        <Route path="/governance" element={<PermissionRoute permissions={["users.view"]}><GovernancePage /></PermissionRoute>} />

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
          path="/guard/verify"
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
