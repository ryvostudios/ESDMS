import { ForbiddenError, NotFoundError, ValidationError } from "../errors/app-error.js";

// Generic department-scope rules, parameterized by the calling module's own
// "all departments" permission code. Mirrors workforce.authorization.js's
// employeeSiteFilter shape, keyed on department instead of site. Extracted
// during the Material Demand checkpoint once a second module
// (material-catalog) needed the identical logic — see docs/DECISIONS.md.
//
// Unlike site_id (NOT NULL on every user), department_id is nullable
// (ADMIN/SITE_MANAGER/GATE_GUARD legitimately have none). A plain
// "null = unrestricted" filter would therefore be ambiguous: null could
// mean "this actor is authorized for every department" or "this actor has
// no department at all". Every function below resolves that explicitly.

export function isAllDepartmentsActor(actor, allDepartmentsPermission) {
  return actor.role === "CEO" || actor.permissions.has(allDepartmentsPermission);
}

// Which department a NEW record is created under. An actor without
// company-wide scope may only create within their own department — an
// explicit mismatch is a visible denial, not a silent server-side override
// (mirrors gate-pass.authorization.js's resolveCreateDepartmentId).
export function resolveCreateDepartmentId(actor, requestedDepartmentId, allDepartmentsPermission) {
  if (isAllDepartmentsActor(actor, allDepartmentsPermission)) {
    if (!requestedDepartmentId) {
      throw new ValidationError("A departmentId is required.");
    }
    return requestedDepartmentId;
  }

  if (requestedDepartmentId && requestedDepartmentId !== actor.departmentId) {
    throw new ForbiddenError("You can only act within your own department.");
  }

  if (!actor.departmentId) {
    throw new ForbiddenError("You are not assigned to a department.");
  }

  return actor.departmentId;
}

// For listing: a scoped actor always sees their own department regardless
// of what's requested (mismatch is an explicit denial, not a silent
// override). A company-wide actor may optionally filter by department;
// omitting it returns every department's data (unfiltered: true).
export function resolveListDepartmentScope(actor, requestedDepartmentId, allDepartmentsPermission) {
  if (isAllDepartmentsActor(actor, allDepartmentsPermission)) {
    return { departmentId: requestedDepartmentId || null, unfiltered: !requestedDepartmentId };
  }

  if (requestedDepartmentId && requestedDepartmentId !== actor.departmentId) {
    throw new ForbiddenError("You can only view your own department's data.");
  }

  return { departmentId: actor.departmentId, unfiltered: false };
}

// Defense in depth on an EXISTING record: a wrong-department id is reported
// identically to a nonexistent one (data-minimization posture already
// established by workforce.authorization.js's assertEmployeeManageable),
// not a 403 that would confirm the record exists in another department.
export function assertDepartmentRecordManageable(actor, recordDepartmentId, allDepartmentsPermission) {
  if (isAllDepartmentsActor(actor, allDepartmentsPermission)) return;

  if (actor.departmentId !== recordDepartmentId) {
    throw new NotFoundError("Record not found.");
  }
}
