import { CMS_PERMISSIONS } from "../../modules/cms/cms-access.js";
import { HomeIcon, TruckIcon, ClipboardCheckIcon, ScanIcon, BoxIcon } from "../../shared/icons.jsx";

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
  // ESDMS-018: no `permission` gate here — My Workforce bundles several
  // independently-gated self-service capabilities (documents/rotation/
  // contracts/compensation need no permission at all beyond having a
  // linked Employee record; only its Profile/Leave children additionally
  // check profile.self.view/leave.self.*, inside MyWorkforcePage itself).
  { label: "My Workforce", to: "/workforce/me", icon: HomeIcon, requiresEmployee: true },
  { label: "Workforce", to: "/workforce", icon: HomeIcon, end: true, permission: ["employees.view"] },
  { label: "Employees", to: "/workforce/employees", icon: ClipboardCheckIcon, permission: ["employees.view"] },
  { label: "Workforce Ops", to: "/workforce/operations", icon: ClipboardCheckIcon, permission: ["leave.approve", "employee_documents.view", "rotation.adjust"] },
  { label: "Reports", to: "/workforce/reports", icon: ClipboardCheckIcon, allPermissions: ["workforce.reports.view", "workforce.export"] },
  { label: "System Administration", to: "/cms", icon: ClipboardCheckIcon, permission: CMS_PERMISSIONS },
  {
    label: "Material Catalog",
    to: "/material-catalog",
    icon: BoxIcon,
    permission: ["material_catalog.view", "material_catalog.manage"],
  },
  {
    label: "Demands",
    to: "/demands",
    icon: ClipboardCheckIcon,
    permission: ["demand.view", "demand.create"],
  },
  {
    label: "Procurement",
    to: "/procurement/pricing",
    icon: BoxIcon,
    permission: ["procurement.pricing"],
  },
  {
    // Operational IPO visibility. Deliberately NOT gated on a price
    // capability: a department lead may follow their own IPO's progress
    // without ever seeing an amount (the backend redacts every commercial
    // column for them, and refuses the IPO PDF outright).
    label: "IPOs",
    to: "/ipos",
    icon: BoxIcon,
    end: true,
    permission: ["ipo.view", "procurement.purchase", "procurement.view_prices"],
  },
  {
    // The delivery document itself. Deliberately separate from Gate Pass:
    // one is the commercial record, the other is vehicle movement.
    label: "Delivery Challans",
    to: "/delivery-challans",
    icon: ClipboardCheckIcon,
    end: true,
    permission: ["dc.view", "dc.manage"],
  },
  {
    label: "Receiving",
    to: "/receiving",
    icon: ClipboardCheckIcon,
    end: true,
    permission: ["receiving.view"],
  },
  {
    label: "Procurement History",
    to: "/procurement/history",
    icon: ClipboardCheckIcon,
    permission: ["ipo.view", "procurement.view_prices", "procurement.purchase", "procurement.export"],
  },
  {
    label: "Drivers",
    to: "/fleet/drivers",
    icon: TruckIcon,
    permission: ["driver.view", "driver.manage"],
  },
  {
    label: "Vehicles",
    to: "/fleet/vehicles",
    icon: TruckIcon,
    permission: ["vehicle.view", "vehicle.manage"],
  },
];
