import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError, NotFoundError } from "../../shared/errors/app-error.js";
import * as service from "./business-history.service.js";
import { removeHistorySchema } from "./business-history.validation.js";

function targetEmployeeId(req) {
  const id = req.params.id || req.user.employeeId;
  if (!id) throw new NotFoundError("No Employee record is linked to your account.");
  return id;
}

export const list = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.getHistory(req.user, targetEmployeeId(req)) });
});

export const remove = asyncHandler(async (req, res) => {
  const parsed = removeHistorySchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError("Invalid request.", parsed.error.flatten());

  const result = await service.removeHistoryEntry(req.user, req.params.entryId, parsed.data);
  res.status(200).json({ success: true, data: result });
});
