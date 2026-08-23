import { HomeIcon, TruckIcon, ClipboardCheckIcon, ScanIcon } from "../../shared/icons.jsx";

const OFFICE_PERMISSIONS = ["gate_pass.view_own", "gate_pass.view_site"];
const GUARD_PERMISSIONS = ["gate_pass.verify", "gate_pass.exit", "gate_pass.return"];

// `permission` (optional) is a list of permission codes — the item shows if
// the user holds ANY of them. Dashboard is scoped to office roles so a
// Guard-only user (who is redirected from "/" to "/guard") doesn't see a
// link back to a page they can't use.
export const NAV_ITEMS = [
  { label: "Dashboard", to: "/", icon: HomeIcon, end: true, permission: OFFICE_PERMISSIONS },
  { label: "Gate Passes", to: "/gate-passes", icon: TruckIcon, permission: OFFICE_PERMISSIONS },
  { label: "Approvals", to: "/approvals", icon: ClipboardCheckIcon, permission: ["gate_pass.approve"] },
  { label: "Gate", to: "/guard", icon: ScanIcon, end: true, permission: GUARD_PERMISSIONS },
  { label: "My Workforce", to: "/workforce/me", icon: HomeIcon, permission: ["profile.self.view"], requiresEmployee: true },
  { label: "Workforce", to: "/workforce", icon: HomeIcon, end: true, permission: ["employees.view"] },
  { label: "Employees", to: "/workforce/employees", icon: ClipboardCheckIcon, permission: ["employees.view"] },
  { label: "Workforce Ops", to: "/workforce/operations", icon: ClipboardCheckIcon, permission: ["leave.approve", "employee_documents.view", "rotation.adjust"] },
  { label: "Reports", to: "/workforce/reports", icon: ClipboardCheckIcon, allPermissions: ["workforce.reports.view", "workforce.export"] },
  { label: "Governance", to: "/governance", icon: ClipboardCheckIcon, permission: ["users.view"] },
  {
    label: "Workforce Config",
    to: "/workforce/config",
    icon: ClipboardCheckIcon,
    permission: ["workforce.configuration.manage", "departments.manage", "positions.manage"],
  },
];
