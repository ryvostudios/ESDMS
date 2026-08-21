import { HomeIcon, TruckIcon, ClipboardCheckIcon } from "../../shared/icons.jsx";

// `permission` (optional) is a list of permission codes — the item shows if
// the user holds ANY of them. Guard-specific destinations land in Phase 6.
export const NAV_ITEMS = [
  { label: "Dashboard", to: "/", icon: HomeIcon, end: true },
  { label: "Gate Passes", to: "/gate-passes", icon: TruckIcon, permission: ["gate_pass.view_own", "gate_pass.view_site"] },
  { label: "Approvals", to: "/approvals", icon: ClipboardCheckIcon, permission: ["gate_pass.approve"] },
];
