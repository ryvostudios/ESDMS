import { NotFoundError } from "../errors/app-error.js";

// Record scope for the purchasing chain (IPO, Delivery Challan, Receiving),
// resolved once per request. It reuses — deliberately, rather than
// reinventing — the exact three-tier shape Material Demand established in
// material-demand.authorization.js:
//
//   ALL  — CEO / demand.all_departments: every site, every department.
//   SITE — a cross-department responsibility holder (Procurement, DC
//          management, review/approval authority, or Admin fallback
//          custody): every department AT THE ACTOR'S OWN SITE.
//   OWN  — an ordinary department actor (Team Lead, Employee): only their
//          own department, at their own site.
//
// Action capability and record scope stay separate at every tier: holding
// receiving.receive says the actor may record a receipt, never which
// department's material. Admin can only reach another department's delivery
// through the separate, narrowly CONTEXTUAL fallback-custody authority below
// — which reaches the delivery being received and nothing else. Ordinary
// receiving.receive never crosses a department boundary either.
export const ALL_DEPARTMENTS_PERMISSION = "demand.all_departments";

// Scope is explicit for Procurement: action capabilities answer WHAT an actor
// may do, while procurement.site_scope answers WHERE. This lets Governance
// deny or remove site reach without also rewriting every operational grant.
// Review/approval remain intrinsically site-wide management authorities.
//
// Two capabilities are deliberately NOT here, for the same underlying reason:
// neither is an authority to act on another department's records.
//
//   procurement.view_prices answers "may this actor see protected pricing
//   FIELDS on records they can already reach?" — a data-visibility question,
//   not an organizational one. Granting a Civil Team Lead price visibility
//   for a legitimate reason must never hand them WTG, E-BOP and Admin IPOs at
//   their site; that would turn a field-level grant into a cross-department
//   financial disclosure. Price visibility is applied where it belongs: the
//   projection layer decides which COLUMNS a request receives, after scope
//   has already decided which RECORDS it receives.
//
//   receiving.fallback_receive authorizes one narrow physical act — taking
//   temporary custody of another department's delivery when nobody from that
//   department is available. Its contextual authority lives in the receiving
//   module, scoped to the delivery being received (see receiving.service.js).
//
// The invariant both cases protect: a capability grants scope only when it is
// an authority to act across departments.
const SITE_WIDE_PERMISSIONS = [
  "procurement.site_scope",
  "demand.review",
  "demand.approve",
];

export function isAllScopeActor(actor) {
  return actor.role === "CEO" || actor.permissions.has(ALL_DEPARTMENTS_PERMISSION);
}

export function hasSiteWideSupplyChainAuthority(actor) {
  return SITE_WIDE_PERMISSIONS.some((code) => actor.permissions.has(code));
}

export function resolveSupplyChainScope(actor) {
  if (isAllScopeActor(actor)) {
    return { tier: "ALL", siteId: null, departmentId: null };
  }

  if (hasSiteWideSupplyChainAuthority(actor)) {
    return { tier: "SITE", siteId: actor.siteId, departmentId: null };
  }

  return { tier: "OWN", siteId: actor.siteId, departmentId: actor.departmentId };
}

// Defense in depth on an existing record. An out-of-scope id is reported
// identically to a nonexistent one — the data-minimization posture every
// other ESDMS module already uses, so a caller cannot probe for the
// existence of another department's or site's purchasing records.
export function assertSupplyChainRecordVisible(actor, record) {
  const scope = resolveSupplyChainScope(actor);

  if (scope.tier === "ALL") return;

  if (record.site_id !== scope.siteId) {
    throw new NotFoundError("Record not found.");
  }

  if (scope.tier === "OWN" && record.department_id !== scope.departmentId) {
    throw new NotFoundError("Record not found.");
  }
}

// Ordinary department receiving/confirmation: strictly the actor's own
// department at their own site, regardless of any site-wide capability they
// may also hold for other purposes. Used by receiving.receive and
// receiving.confirm, which must never become cross-department merely because
// the actor also happens to hold, say, procurement.view_prices.
export function assertOwnDepartmentRecord(actor, record) {
  if (isAllScopeActor(actor)) return;

  if (!actor.departmentId || record.department_id !== actor.departmentId || record.site_id !== actor.siteId) {
    throw new NotFoundError("Record not found.");
  }
}

// Contextual authority for the Admin fallback path ONLY.
//
// Narrow by construction: it grants site-bound, cross-department reach to the
// specific delivery being received and to nothing else. It is never used for
// IPO, purchasing, history, carry-forward, reports or any commercial surface.
export function hasFallbackReceivingAuthority(actor) {
  return actor.permissions.has("receiving.fallback_receive");
}

export function isWithinActorSite(actor, record) {
  return Boolean(actor.siteId) && record.site_id === actor.siteId;
}
