import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError, NotFoundError } from "../../shared/errors/app-error.js";
import * as service from "./compensation.service.js";
import { recordCompensationSchema } from "./compensation.validation.js";

function targetEmployeeId(req) {
  const id = req.params.id || req.user.employeeId;
  if (!id) throw new NotFoundError("No Employee record is linked to your account.");
  return id;
}

export const current = asyncHandler(async (req, res) => {
  const record = await service.getCurrentCompensation(req.user, targetEmployeeId(req));
  res.status(200).json({ success: true, data: record });
});

export const history = asyncHandler(async (req, res) => {
  const records = await service.getCompensationHistory(req.user, targetEmployeeId(req));
  res.status(200).json({ success: true, data: records });
});

export const create = asyncHandler(async (req, res) => {
  const parsed = recordCompensationSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError("Invalid request.", parsed.error.flatten());

  const created = await service.recordCompensation(req.user, targetEmployeeId(req), parsed.data);
  res.status(201).json({ success: true, data: created });
});
