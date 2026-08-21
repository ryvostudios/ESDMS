// Centralized Gate Pass scope rules — every place that needs "can this
// user see/touch this record" calls through here instead of re-deriving
// role checks inline.
//
// gate_pass.view_site (ADMIN, SITE_MANAGER) -> site-wide, no restriction.
// gate_pass.view_own (TEAM_LEAD) -> scoped to the user's own department.
// "Team" is defined as "same department" for now — see docs/DECISIONS.md
// ("Team" Scope Defaults to Department) — there is no separate team table.
export function isWithinGatePassScope(user, gatePass) {
  if (user.permissions.has("gate_pass.view_site")) {
    return true;
  }

  if (user.permissions.has("gate_pass.view_own")) {
    return Boolean(user.departmentId) && gatePass.issuing_department_id === user.departmentId;
  }

  return false;
}
