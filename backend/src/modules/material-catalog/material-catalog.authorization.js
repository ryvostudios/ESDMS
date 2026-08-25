import * as departmentScope from "../../shared/authorization/department-scope.js";

// Material Catalog's department-scope rules, pinned to this module's own
// "all departments" permission code — the actual logic lives in the
// generic shared/authorization/department-scope.js helper (extracted here
// once the Material Demand module needed the identical rules).

export const ALL_DEPARTMENTS_PERMISSION = "material_catalog.all_departments";

export const resolveCatalogDepartmentId = (actor, requestedDepartmentId) =>
  departmentScope.resolveCreateDepartmentId(actor, requestedDepartmentId, ALL_DEPARTMENTS_PERMISSION);

export const resolveListDepartmentScope = (actor, requestedDepartmentId) =>
  departmentScope.resolveListDepartmentScope(actor, requestedDepartmentId, ALL_DEPARTMENTS_PERMISSION);

export const assertCatalogEntryManageable = (actor, entry) =>
  departmentScope.assertDepartmentRecordManageable(actor, entry.department_id, ALL_DEPARTMENTS_PERMISSION);
