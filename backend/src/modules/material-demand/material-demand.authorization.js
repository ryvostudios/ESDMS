import { ForbiddenError, NotFoundError } from "../../shared/errors/app-error.js";
import * as departmentScope from "../../shared/authorization/department-scope.js";
import { APPROVAL_PERMISSION } from "./material-demand.constants.js";

// Material Demand's scope rules. Two distinct shapes exist in this module,
// deliberately kept separate:
//
//   - "Own department" scope (resolveDemandDepartmentId, assertDemandManageable)
//     — the ordinary creator's view/edit/submit authority, pinned to
//     literally their own department, exactly as Checkpoint 2 established.
//   - "Site-wide management" scope (hasReviewAuthority, assertReviewActionAllowed,
//     resolveDemandListScope's SITE tier) — a Management Reviewer/Formal
//     Approver (for example, Site Manager or Upper Management) may have NO
//     department of their own (department_id is nullable — see gate-pass.
//     authorization.js) but is authorized across every department AT
//     THEIR OWN SITE, mirroring Gate Pass's existing `gate_pass.view_site`
//     model exactly. Only CEO/`demand.all_departments` goes further, to
//     every site.

export const ALL_DEPARTMENTS_PERMISSION = "demand.all_departments";
export const PROCUREMENT_SITE_SCOPE_PERMISSION = "procurement.site_scope";

function isAllDepartmentsActor(actor) {
  return departmentScope.isAllDepartmentsActor(actor, ALL_DEPARTMENTS_PERMISSION);
}

export function hasReviewAuthority(actor) {
  return actor.permissions.has(APPROVAL_PERMISSION.MANAGEMENT_REVIEW) || actor.permissions.has(APPROVAL_PERMISSION.FORMAL_APPROVAL);
}

function hasSiteWideDemandAuthority(actor) {
  return hasReviewAuthority(actor) || actor.permissions.has(PROCUREMENT_SITE_SCOPE_PERMISSION);
}

export const resolveDemandDepartmentId = (actor, requestedDepartmentId) =>
  departmentScope.resolveCreateDepartmentId(actor, requestedDepartmentId, ALL_DEPARTMENTS_PERMISSION);

export const assertDemandManageable = (actor, demand) =>
  departmentScope.assertDepartmentRecordManageable(actor, demand.department_id, ALL_DEPARTMENTS_PERMISSION);

// For recording a review/approval decision. The route already gates on
// holding demand.review/demand.approve at all — this only confirms the
// actor's scope actually reaches this specific Demand's site (or every
// site, for CEO/all-departments). A wrong-site id is reported identically
// to a nonexistent one, matching the existing data-minimization posture.
export function assertReviewActionAllowed(actor, demand) {
  if (isAllDepartmentsActor(actor)) return;

  if (actor.siteId !== demand.site_id) {
    throw new NotFoundError("Demand not found.");
  }
}

// Broader than assertDemandManageable — used for the read-only detail
// view only (never for edit/submit/review/approve). A site-wide reviewer
// must be able to see a Demand they're eligible to act on even though
// they don't belong to its department; an ordinary creator still only
// sees their own department's Demands.
export function assertDemandViewable(actor, demand) {
  if (isAllDepartmentsActor(actor)) return;

  if (hasSiteWideDemandAuthority(actor) && actor.siteId === demand.site_id) return;

  departmentScope.assertDepartmentRecordManageable(actor, demand.department_id, ALL_DEPARTMENTS_PERMISSION);
}

// Three-tier list scope, resolved once per request:
//   ALL    — CEO / demand.all_departments: every site, every department
//            (optionally still filterable to one department).
//   SITE   — holds demand.review or demand.approve: every department at
//            the actor's own site (optionally filterable to one
//            department within it).
//   OWN    — ordinary creator/view-only actor: locked to their own
//            department, exactly as Checkpoint 2 established; an explicit
//            department mismatch is a denial, not a silent override.
// Returns { siteId, departmentId } for the repository's WHERE clause —
// both null means "no restriction on that column".
export function resolveDemandListScope(actor, requestedDepartmentId) {
  if (isAllDepartmentsActor(actor)) {
    return { tier: "ALL", siteId: null, departmentId: requestedDepartmentId || null };
  }

  if (hasSiteWideDemandAuthority(actor)) {
    return { tier: "SITE", siteId: actor.siteId, departmentId: requestedDepartmentId || null };
  }

  if (requestedDepartmentId && requestedDepartmentId !== actor.departmentId) {
    throw new ForbiddenError("You can only view your own department's data.");
  }

  // tier "OWN" — departmentId may be null here (an actor with no
  // department assigned and no broader scope); the caller must treat that
  // as "nothing to show", never as "unrestricted" (see resolveDemandListScope's tier).
  return { tier: "OWN", siteId: null, departmentId: actor.departmentId };
}
