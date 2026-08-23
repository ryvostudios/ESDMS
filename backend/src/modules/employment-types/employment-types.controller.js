import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError, ConflictError, NotFoundError } from "../../shared/errors/app-error.js";
import { createEmploymentTypeSchema, updateEmploymentTypeSchema } from "./employment-types.validation.js";
import {
  listActiveEmploymentTypes,
  listEmploymentTypes,
  findEmploymentTypeById,
  codeExists,
  insertEmploymentType,
  updateEmploymentTypeFields,
  hasActiveAssignments,
} from "./employment-types.repository.js";

function parseBody(schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid request.", parsed.error.flatten());
  return parsed.data;
}

export const list = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await listActiveEmploymentTypes() });
});

export const listAll = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await listEmploymentTypes() });
});

export const create = asyncHandler(async (req, res) => {
  const input = parseBody(createEmploymentTypeSchema, req.body);
  if (await codeExists(input.code)) throw new ConflictError("An employment type with this code already exists.");

  const created = await insertEmploymentType(input.code, input.name);
  res.status(201).json({ success: true, data: created });
});

export const update = asyncHandler(async (req, res) => {
  const input = parseBody(updateEmploymentTypeSchema, req.body);
  const existing = await findEmploymentTypeById(req.params.id);
  if (!existing) throw new NotFoundError("Employment type not found.");

  if (input.isActive === false && (await hasActiveAssignments(existing.id))) {
    throw new ConflictError("Cannot archive an employment type with active employees assigned.");
  }

  const updated = await updateEmploymentTypeFields(existing.id, input);
  res.status(200).json({ success: true, data: updated });
});
