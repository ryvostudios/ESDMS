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
import { MaterialCatalogPage } from "../../modules/material-catalog/pages/MaterialCatalogPage.jsx";
import { DemandListPage } from "../../modules/material-demand/pages/DemandListPage.jsx";
import { DemandFormPage } from "../../modules/material-demand/pages/DemandFormPage.jsx";
import { DemandDetailPage } from "../../modules/material-demand/pages/DemandDetailPage.jsx";
import { PricingQueuePage } from "../../modules/procurement/pages/PricingQueuePage.jsx";
import { PricingPage } from "../../modules/procurement/pages/PricingPage.jsx";
import { ProcurementHistoryPage } from "../../modules/procurement/pages/ProcurementHistoryPage.jsx";
import { IpoListPage } from "../../modules/ipo/pages/IpoListPage.jsx";
import { IpoDetailPage } from "../../modules/ipo/pages/IpoDetailPage.jsx";
import { DeliveryChallanDetailPage } from "../../modules/delivery-challan/pages/DeliveryChallanDetailPage.jsx";
import { ReceivingQueuePage } from "../../modules/receiving/pages/ReceivingQueuePage.jsx";
import { ReceiveDeliveryPage } from "../../modules/receiving/pages/ReceiveDeliveryPage.jsx";
import { ReceiptDetailPage } from "../../modules/receiving/pages/ReceiptDetailPage.jsx";
import { DiagnosticsPage } from "./DiagnosticsPage.jsx";

const GUARD_PERMISSIONS = ["gate_pass.verify", "gate_pass.exit", "gate_pass.return"];

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/diagnostics" element={<DiagnosticsPage />} />
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

        {/* ESDMS-018: no PermissionRoute gate — MyWorkforcePage is fully
            self-guarding (no linked Employee -> unavailable message; each
            child tab is independently gated inside the page). Documents/
            Rotation/Contracts/Compensation need no permission at all, so a
            single permission-code gate here would have hidden them for a
            linked Employee who legitimately lacks profile.self.view. */}
        <Route path="/workforce/me" element={<MyWorkforcePage />} />
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
          path="/material-catalog"
          element={
            <PermissionRoute permissions={["material_catalog.view", "material_catalog.manage"]}>
              <MaterialCatalogPage />
            </PermissionRoute>
          }
        />
        <Route
          path="/demands"
          element={
            <PermissionRoute permissions={["demand.view", "demand.create"]}>
              <DemandListPage />
            </PermissionRoute>
          }
        />
        <Route
          path="/demands/new"
          element={
            <PermissionRoute permissions={["demand.create"]}>
              <DemandFormPage />
            </PermissionRoute>
          }
        />
        <Route
          path="/demands/:id/edit"
          element={
            <PermissionRoute permissions={["demand.edit"]}>
              <DemandFormPage />
            </PermissionRoute>
          }
        />
        <Route
          path="/demands/:id"
          element={
            <PermissionRoute permissions={["demand.view", "demand.review", "demand.approve"]}>
              <DemandDetailPage />
            </PermissionRoute>
          }
        />
        <Route
          path="/procurement/pricing"
          element={
            <PermissionRoute permissions={["procurement.pricing"]}>
              <PricingQueuePage />
            </PermissionRoute>
          }
        />
        <Route
          path="/procurement/pricing/:demandId"
          element={
            <PermissionRoute permissions={["procurement.pricing"]}>
              <PricingPage />
            </PermissionRoute>
          }
        />

        <Route
          path="/procurement/history"
          element={
            <PermissionRoute permissions={["ipo.view", "procurement.view_prices", "procurement.purchase", "procurement.export"]}>
              <ProcurementHistoryPage />
            </PermissionRoute>
          }
        />
        <Route
          path="/ipos"
          element={
            <PermissionRoute permissions={["ipo.view", "procurement.purchase", "procurement.view_prices"]}>
              <IpoListPage />
            </PermissionRoute>
          }
        />
        <Route
          path="/ipos/:id"
          element={
            <PermissionRoute permissions={["ipo.view", "procurement.purchase", "procurement.view_prices"]}>
              <IpoDetailPage />
            </PermissionRoute>
          }
        />
        <Route
          path="/delivery-challans/:id"
          element={
            <PermissionRoute permissions={["dc.view", "dc.manage"]}>
              <DeliveryChallanDetailPage />
            </PermissionRoute>
          }
        />
        <Route
          path="/receiving"
          element={
            <PermissionRoute permissions={["receiving.view"]}>
              <ReceivingQueuePage />
            </PermissionRoute>
          }
        />
        <Route
          path="/receiving/challans/:id"
          element={
            <PermissionRoute permissions={["receiving.view"]}>
              <ReceiveDeliveryPage />
            </PermissionRoute>
          }
        />
        <Route
          path="/receiving/receipts/:id"
          element={
            <PermissionRoute permissions={["receiving.view"]}>
              <ReceiptDetailPage />
            </PermissionRoute>
          }
        />

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
