import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError, ConflictError, NotFoundError } from "../../shared/errors/app-error.js";
import { resolveCreateSiteId, employeeSiteFilter } from "../workforce/workforce.authorization.js";
import { createDepartmentSchema, updateDepartmentSchema } from "./departments.validation.js";
import {
  listActiveDepartmentsForSite,
  listDepartmentsForSite,
  findDepartmentById,
  nameExistsForSite,
  insertDepartment,
  updateDepartmentFields,
  hasActiveAssignments,
} from "./departments.repository.js";

function parseBody(schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid request.", parsed.error.flatten());
  return parsed.data;
}

export const list = asyncHandler(async (req, res) => {
  const rows = await listActiveDepartmentsForSite(req.user.siteId);
  res.status(200).json({ success: true, data: rows });
});

// Workforce configuration view: all departments (active + archived) for the
// actor's site, or every site for a company-wide scope.
export const listAll = asyncHandler(async (req, res) => {
  const scope = employeeSiteFilter(req.user);
  const rows = scope === null ? [] : await listDepartmentsForSite(scope);
  res.status(200).json({ success: true, data: rows });
});

export const create = asyncHandler(async (req, res) => {
  const input = parseBody(createDepartmentSchema, req.body);
  const siteId = resolveCreateSiteId(req.user, input.siteId);

  if (await nameExistsForSite(siteId, input.name)) {
    throw new ConflictError("A department with this name already exists at this site.");
  }

  const created = await insertDepartment(siteId, input.name);
  res.status(201).json({ success: true, data: created });
});

export const update = asyncHandler(async (req, res) => {
  const input = parseBody(updateDepartmentSchema, req.body);
  const department = await findDepartmentById(req.params.id);
  if (!department) throw new NotFoundError("Department not found.");

  const scope = employeeSiteFilter(req.user);
  if (scope !== null && scope !== department.site_id) {
    throw new NotFoundError("Department not found.");
  }

  if (input.isActive === false && (await hasActiveAssignments(department.id))) {
    throw new ConflictError("Cannot archive a department with active employees assigned. Reassign them first.");
  }

  if (input.name && (await nameExistsForSite(department.site_id, input.name))) {
    throw new ConflictError("A department with this name already exists at this site.");
  }

  const updated = await updateDepartmentFields(department.id, input);
  res.status(200).json({ success: true, data: updated });
});
