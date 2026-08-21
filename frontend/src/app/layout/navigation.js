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
];
