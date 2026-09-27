import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError, NotFoundError } from "../../shared/errors/app-error.js";
import * as service from "./rotation.service.js";
import { createPolicySchema, updatePolicySchema, adjustSchema } from "./rotation.validation.js";

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

export const listPolicies = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.listPolicies() });
});
export const createPolicy = asyncHandler(async (req, res) => {
  const input = parseBody(createPolicySchema, req.body);
  res.status(201).json({ success: true, data: await service.createPolicy(input, req.user) });
});
export const updatePolicy = asyncHandler(async (req, res) => {
  const input = parseBody(updatePolicySchema, req.body);
  res.status(200).json({ success: true, data: await service.updatePolicy(req.params.policyId, input, req.user) });
});

export const status = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.getMyOrEmployeeStatus(req.user, targetEmployeeId(req)) });
});

export const adjust = asyncHandler(async (req, res) => {
  const input = parseBody(adjustSchema, req.body);
  const entry = await service.adjustBalance(req.user, targetEmployeeId(req), input);
  res.status(201).json({ success: true, data: entry });
});
