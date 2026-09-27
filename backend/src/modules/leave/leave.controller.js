import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError, NotFoundError } from "../../shared/errors/app-error.js";
import * as service from "./leave.service.js";
import { createTypeSchema, updateTypeSchema, submitLeaveSchema, decideLeaveSchema } from "./leave.validation.js";

function parseBody(schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid request.", parsed.error.flatten());
  return parsed.data;
}

function targetEmployeeId(req) {
  const id = req.params.id || req.user.employeeId;
  if (!id) throw new NotFoundError("No Employee record is linked to your account.");
  return id;
}

export const listTypes = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.listTypes() });
});
export const createType = asyncHandler(async (req, res) => {
  const input = parseBody(createTypeSchema, req.body);
  res.status(201).json({ success: true, data: await service.createType(input, req.user) });
});
export const updateType = asyncHandler(async (req, res) => {
  const input = parseBody(updateTypeSchema, req.body);
  res.status(200).json({ success: true, data: await service.updateType(req.params.typeId, input, req.user) });
});

export const submit = asyncHandler(async (req, res) => {
  const input = parseBody(submitLeaveSchema, req.body);
  const created = await service.submitLeave(req.user, targetEmployeeId(req), input);
  res.status(201).json({ success: true, data: created });
});

export const list = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.listMyOrEmployeeLeave(req.user, targetEmployeeId(req)) });
});

export const pending = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.listPending(req.user) });
});

export const decide = asyncHandler(async (req, res) => {
  const input = parseBody(decideLeaveSchema, req.body);
  res.status(200).json({ success: true, data: await service.decideLeave(req.user, req.params.requestId, input) });
});

export const cancel = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.cancelMyLeave(req.user, req.params.requestId) });
});
