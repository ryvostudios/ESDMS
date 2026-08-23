import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError } from "../../shared/errors/app-error.js";
import * as service from "./workforce-config.service.js";
import {
  createSectionSchema,
  updateSectionSchema,
  createFieldSchema,
  updateFieldSchema,
  createDocumentTypeSchema,
  updateDocumentTypeSchema,
} from "./workforce-config.validation.js";

function parseBody(schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid request.", parsed.error.flatten());
  return parsed.data;
}

export const listSections = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.listSectionsForActor(req.user) });
});
export const createSection = asyncHandler(async (req, res) => {
  const input = parseBody(createSectionSchema, req.body);
  res.status(201).json({ success: true, data: await service.createSection(input) });
});
export const updateSection = asyncHandler(async (req, res) => {
  const input = parseBody(updateSectionSchema, req.body);
  res.status(200).json({ success: true, data: await service.updateSection(req.params.id, input) });
});

export const listFields = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.listFieldsForActor(req.user) });
});
export const createField = asyncHandler(async (req, res) => {
  const input = parseBody(createFieldSchema, req.body);
  res.status(201).json({ success: true, data: await service.createField(input) });
});
export const updateField = asyncHandler(async (req, res) => {
  const input = parseBody(updateFieldSchema, req.body);
  res.status(200).json({ success: true, data: await service.updateField(req.params.id, input) });
});

export const listDocumentTypes = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.listDocumentTypesForActor(req.user) });
});
export const createDocumentType = asyncHandler(async (req, res) => {
  const input = parseBody(createDocumentTypeSchema, req.body);
  res.status(201).json({ success: true, data: await service.createDocumentType(input) });
});
export const updateDocumentType = asyncHandler(async (req, res) => {
  const input = parseBody(updateDocumentTypeSchema, req.body);
  res.status(200).json({ success: true, data: await service.updateDocumentType(req.params.id, input) });
});
