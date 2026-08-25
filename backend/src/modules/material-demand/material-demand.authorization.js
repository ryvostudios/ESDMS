import * as departmentScope from "../../shared/authorization/department-scope.js";

// Material Demand's department-scope rules, pinned to this module's own
// "all departments" permission code — the actual logic lives in
// shared/authorization/department-scope.js (see docs/DECISIONS.md).

export const ALL_DEPARTMENTS_PERMISSION = "demand.all_departments";

export const resolveDemandDepartmentId = (actor, requestedDepartmentId) =>
  departmentScope.resolveCreateDepartmentId(actor, requestedDepartmentId, ALL_DEPARTMENTS_PERMISSION);

export const resolveListDepartmentScope = (actor, requestedDepartmentId) =>
  departmentScope.resolveListDepartmentScope(actor, requestedDepartmentId, ALL_DEPARTMENTS_PERMISSION);

export const assertDemandManageable = (actor, demand) =>
  departmentScope.assertDepartmentRecordManageable(actor, demand.department_id, ALL_DEPARTMENTS_PERMISSION);
