import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError } from "../../shared/errors/app-error.js";
import * as service from "./users.service.js";
import { createUserSchema, changeRoleSchema, permissionOverrideSchema } from "./users.validation.js";

function parseBody(schema, body) {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new ValidationError("Invalid request.", parsed.error.flatten());
  }

  return parsed.data;
}

function toUserDto(row) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    isActive: row.is_active,
    siteId: row.site_id,
    departmentId: row.department_id,
    createdAt: row.created_at,
  };
}

export const create = asyncHandler(async (req, res) => {
  const input = parseBody(createUserSchema, req.body);
  const created = await service.createUser(req.user, input);

  res.status(201).json({ success: true, data: toUserDto({ ...created, role: input.role }) });
});

export const list = asyncHandler(async (req, res) => {
  const rows = await service.listUsers(req.user);
  res.status(200).json({ success: true, data: rows.map(toUserDto) });
});

export const getOne = asyncHandler(async (req, res) => {
  const target = await service.getUser(req.user, req.params.id);
  res.status(200).json({ success: true, data: toUserDto(target) });
});

export const changeRole = asyncHandler(async (req, res) => {
  const input = parseBody(changeRoleSchema, req.body);
  const result = await service.changeUserRole(req.user, req.params.id, input.role);
  res.status(200).json({ success: true, data: result });
});

export const activate = asyncHandler(async (req, res) => {
  const result = await service.activateUser(req.user, req.params.id);
  res.status(200).json({ success: true, data: result });
});

export const deactivate = asyncHandler(async (req, res) => {
  const result = await service.deactivateUser(req.user, req.params.id);
  res.status(200).json({ success: true, data: result });
});

export const getPermissions = asyncHandler(async (req, res) => {
  const overview = await service.getPermissionOverview(req.user, req.params.id);
  res.status(200).json({ success: true, data: overview });
});

export const setPermission = asyncHandler(async (req, res) => {
  const input = parseBody(permissionOverrideSchema, req.body);
  const result = await service.setPermissionOverride(
    req.user,
    req.params.id,
    req.params.code,
    input.effect,
    input.reason,
  );
  res.status(200).json({ success: true, data: result });
});

export const removePermission = asyncHandler(async (req, res) => {
  const result = await service.removePermissionOverride(req.user, req.params.id, req.params.code);
  res.status(200).json({ success: true, data: result });
});
