import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError, NotFoundError } from "../../shared/errors/app-error.js";
import * as service from "./profile.service.js";
import { extractPhoto } from "./photo.upload.js";
import {
  updatePersonalDetailsSchema,
  emergencyContactSchema,
  updateEmergencyContactSchema,
  customFieldValueSchema,
} from "./profile.validation.js";

function parseBody(schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid request.", parsed.error.flatten());
  return parsed.data;
}

// Every handler resolves the target employee id from either the route's
// :id or, for "/me" mounts, the caller's own linked employeeId — see
// profile.routes.js.
function targetEmployeeId(req) {
  const id = req.params.id || req.user.employeeId;
  if (!id) throw new NotFoundError("No Employee record is linked to your account.");
  return id;
}

export const getProfile = asyncHandler(async (req, res) => {
  const profile = await service.getProfile(req.user, targetEmployeeId(req));
  res.status(200).json({ success: true, data: profile });
});

export const updatePersonalDetails = asyncHandler(async (req, res) => {
  const input = parseBody(updatePersonalDetailsSchema, req.body);
  const updated = await service.updatePersonalDetails(req.user, targetEmployeeId(req), input);
  res.status(200).json({ success: true, data: updated });
});

export const addEmergencyContact = asyncHandler(async (req, res) => {
  const input = parseBody(emergencyContactSchema, req.body);
  const created = await service.addEmergencyContact(req.user, targetEmployeeId(req), input);
  res.status(201).json({ success: true, data: created });
});

export const updateEmergencyContact = asyncHandler(async (req, res) => {
  const input = parseBody(updateEmergencyContactSchema, req.body);
  const updated = await service.editEmergencyContact(req.user, req.params.contactId, input);
  res.status(200).json({ success: true, data: updated });
});

export const removeEmergencyContact = asyncHandler(async (req, res) => {
  await service.removeEmergencyContact(req.user, req.params.contactId);
  res.status(204).send();
});

export const setCustomFieldValue = asyncHandler(async (req, res) => {
  const input = parseBody(customFieldValueSchema, req.body);
  const updated = await service.setCustomFieldValue(req.user, targetEmployeeId(req), req.params.fieldId, input.value);
  res.status(200).json({ success: true, data: updated });
});

export const uploadPhoto = asyncHandler(async (req, res) => {
  const photo = extractPhoto(req);
  const result = await service.uploadProfilePhoto(req.user, targetEmployeeId(req), photo);
  res.status(201).json({ success: true, data: { id: result.id, version: result.version } });
});

export const downloadPhoto = asyncHandler(async (req, res) => {
  const { buffer, mimeType } = await service.getProfilePhotoFile(req.user, targetEmployeeId(req));
  res.set({
    "Content-Type": mimeType,
    "Content-Disposition": "inline",
    "Cache-Control": "private, no-store",
  });
  res.status(200).send(buffer);
});
