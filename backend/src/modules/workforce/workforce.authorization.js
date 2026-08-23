import { ForbiddenError, NotFoundError, ValidationError } from "../../shared/errors/app-error.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Centralized Workforce scope/visibility rules — every service function
// that loads or lists Employee-scoped data calls through here instead of
// re-deriving `if (role === "CEO")` inline (docs/SECURITY.md §6.1 already
// established this pattern for governance; Workforce reuses it).

export const ALL_SITES_PERMISSION = "workforce.all_sites";

// null = no site restriction (CEO, or an explicit company-wide grant).
// Otherwise the actor's own site — never trusted from a request parameter.
export function employeeSiteFilter(actor) {
  if (actor.role === "CEO" || actor.permissions.has(ALL_SITES_PERMISSION)) {
    return null;
  }
  return actor.siteId;
}

export function isSelf(actor, employee) {
  return Boolean(actor.employeeId) && actor.employeeId === employee.id;
}

// Self access is identity-based (does this request's own linked Employee
// match the target?), never a permission flag — an EMPLOYEE role holder
// with zero "employees.*" permissions must still reach their own record.
// A wrong-site id is reported identically to a nonexistent one, matching
// gate-pass.authorization.js's existing data-minimization posture.
export function assertEmployeeViewable(actor, employee, permissionCode = "employees.view") {
  if (isSelf(actor, employee)) return;

  if (!actor.permissions.has(permissionCode)) {
    throw new ForbiddenError();
  }

  const scope = employeeSiteFilter(actor);
  if (scope !== null && scope !== employee.primary_site_id) {
    throw new NotFoundError("Employee not found.");
  }
}

// Mutations are never satisfied by self-access alone (an employee editing
// their own core HR-owned fields goes through the separate, narrower
// personal-details surface, not this check) — only an explicit permission
// plus site scope.
export function assertEmployeeManageable(actor, employee, permissionCode) {
  if (!actor.permissions.has(permissionCode)) {
    throw new ForbiddenError();
  }

  const scope = employeeSiteFilter(actor);
  if (scope !== null && scope !== employee.primary_site_id) {
    throw new NotFoundError("Employee not found.");
  }
}

// For creating a new Employee: an actor without company-wide scope may only
// create within their own site — an explicit mismatch is a denial, not a
// silent override (mirrors gate-pass.authorization.js's
// resolveCreateDepartmentId and users.service.js's resolveCreateSiteId).
export function resolveCreateSiteId(actor, requestedSiteId) {
  const scope = employeeSiteFilter(actor);
  if (scope === null) {
    return requestedSiteId || actor.siteId;
  }
  if (requestedSiteId && requestedSiteId !== actor.siteId) {
    throw new ForbiddenError("You can only create employees within your own site.");
  }
  return actor.siteId;
}

// ESDMS-035 / PASS1-R04: the active-catalog selector (Departments/Positions
// dropdowns feeding Add Employee) is a different question from the
// all-site *management* list — a selector must always resolve to exactly
// one site's active entries, never an implicit/ambiguous default. A
// site-scoped actor's own site is used regardless of what's requested
// (mismatch rejected, same posture as resolveCreateSiteId); a company-wide
// actor must say which site explicitly — no silent fallback to their own,
// since they may have none, or want a different one.
export function resolveTargetSiteId(actor, requestedSiteId) {
  const scope = employeeSiteFilter(actor);

  if (scope !== null) {
    if (requestedSiteId && requestedSiteId !== actor.siteId) {
      throw new ForbiddenError("You can only view catalog data for your own site.");
    }
    return actor.siteId;
  }

  if (!requestedSiteId || !UUID_PATTERN.test(requestedSiteId)) {
    throw new ValidationError("A valid siteId is required to resolve site-specific catalog data.");
  }
  return requestedSiteId;
}
