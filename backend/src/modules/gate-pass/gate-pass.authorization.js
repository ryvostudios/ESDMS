import { ForbiddenError, ValidationError } from "../../shared/errors/app-error.js";
import { findDepartmentById } from "../departments/departments.repository.js";

// Centralized Gate Pass scope rules — every place that needs "can this
// user see/touch this record" calls through here instead of re-deriving
// role checks inline.
//
// Site is checked first and is absolute: nothing about a role grants
// cross-site access today. A CEO/company-wide permission spanning sites
// deliberately would be a new, explicit permission later, not a loosening
// of this check.
//
// gate_pass.view_site (ADMIN, SITE_MANAGER) -> site-wide within own site.
// gate_pass.view_own (TEAM_LEAD) -> scoped to the user's own department.
// "Team" is defined as "same department" for now — see docs/DECISIONS.md
// ("Team" Scope Defaults to Department) — there is no separate team table.
export function isWithinGatePassScope(user, gatePass) {
  if (gatePass.site_id !== user.siteId) {
    return false;
  }

  if (user.permissions.has("gate_pass.view_site")) {
    return true;
  }

  if (user.permissions.has("gate_pass.view_own")) {
    return Boolean(user.departmentId) && gatePass.issuing_department_id === user.departmentId;
  }

  return false;
}

// Which department a NEW Gate Pass is created under. For an actor without
// site-wide scope (Team Lead), submitting any department other than their
// own is an explicit, visible denial — not a silent server-side override.
// Silently substituting was safe against ownership escalation but hid a
// real correctness/UX problem: a Team Lead who genuinely believed they
// were filing under a different department got no indication their intent
// was discarded. The frontend already only ever offers a Team Lead their
// own department (see useDepartments.js), so this should never actually
// trigger from the real UI — it exists for a client that sends something
// else anyway (a bug, a manual API call).
export function resolveCreateDepartmentId(actor, requestedDepartmentId) {
  if (actor.permissions.has("gate_pass.view_site")) {
    return requestedDepartmentId;
  }

  if (requestedDepartmentId !== actor.departmentId) {
    throw new ForbiddenError("You can only create a Gate Pass for your own department.");
  }

  return actor.departmentId;
}

// For an EXISTING draft, a scope-limited actor moving it to a different
// department must be an explicit, visible denial — not a silent
// server-side override — since they're knowingly trying to change a field
// on a record that already exists.
export function assertDepartmentChangeAllowed(actor, nextDepartmentId) {
  if (actor.permissions.has("gate_pass.view_site")) {
    return;
  }

  if (nextDepartmentId !== actor.departmentId) {
    throw new ForbiddenError("You cannot move this Gate Pass to another department.");
  }
}

// Defense in depth beyond resolve/assert above: whatever department id is
// finally about to be written, it must actually exist, be active, and
// belong to the actor's own site — collapsed into one message so a
// wrong-site department id can't be distinguished from a nonexistent one.
export async function assertDepartmentUsable(actor, departmentId) {
  const department = departmentId ? await findDepartmentById(departmentId) : null;

  if (!department || !department.is_active || department.site_id !== actor.siteId) {
    throw new ValidationError("Invalid department.");
  }
}
