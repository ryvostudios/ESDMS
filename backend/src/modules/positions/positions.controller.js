import { mutateConfiguration } from "../../shared/audit/configuration-audit.js";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError, ConflictError, NotFoundError } from "../../shared/errors/app-error.js";
import { resolveCreateSiteId, resolveTargetSiteId, employeeSiteFilter } from "../workforce/workforce.authorization.js";
import { findDepartmentById } from "../departments/departments.repository.js";
import { createPositionSchema, updatePositionSchema, positionListQuerySchema } from "./positions.validation.js";
import {
  listActivePositionsForSite,
  listPositionsForSite,
  findPositionById,
  codeExistsForSite,
  insertPosition,
  updatePositionFields,
  hasActiveAssignments,
} from "./positions.repository.js";

function parseBody(schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid request.", parsed.error.flatten());
  return parsed.data;
}

async function assertDepartmentUsable(departmentId, siteId) {
  if (!departmentId) return;
  const department = await findDepartmentById(departmentId);
  if (!department || !department.is_active || department.site_id !== siteId) {
    throw new ValidationError("Invalid department.");
  }
}

export const list = asyncHandler(async (req, res) => {
  const query = parseBody(positionListQuerySchema, req.query);
  const siteId = resolveTargetSiteId(req.user, query.siteId);
  const rows = await listActivePositionsForSite(siteId);
  res.status(200).json({ success: true, data: rows });
});

export const listAll = asyncHandler(async (req, res) => {
  const scope = employeeSiteFilter(req.user);
  const rows = await listPositionsForSite(scope);
  res.status(200).json({ success: true, data: rows });
});

export const create = asyncHandler(async (req, res) => {
  const input = parseBody(createPositionSchema, req.body);
  const siteId = resolveCreateSiteId(req.user, input.siteId, "positions");

  if (await codeExistsForSite(siteId, input.code)) {
    throw new ConflictError("A position with this code already exists at this site.");
  }
  await assertDepartmentUsable(input.departmentId, siteId);

  const created = await mutateConfiguration(req.user, "positions", null, client => insertPosition({ siteId, ...input }, client));
  res.status(201).json({ success: true, data: created });
});

export const update = asyncHandler(async (req, res) => {
  const input = parseBody(updatePositionSchema, req.body);
  const position = await findPositionById(req.params.id);
  if (!position) throw new NotFoundError("Position not found.");

  const scope = employeeSiteFilter(req.user);
  if (scope !== null && scope !== position.site_id) throw new NotFoundError("Position not found.");

  if (input.isActive === false && (await hasActiveAssignments(position.id))) {
    throw new ConflictError("Cannot archive a position with active employees assigned. Reassign them first.");
  }
  if (input.departmentId) await assertDepartmentUsable(input.departmentId, position.site_id);

  const updated = await mutateConfiguration(req.user, "positions", position.id, client => updatePositionFields(position.id, input, client));
  res.status(200).json({ success: true, data: updated });
});
