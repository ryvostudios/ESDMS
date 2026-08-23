import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError, NotFoundError } from "../../shared/errors/app-error.js";
import * as service from "./documents.service.js";
import { extractDocumentFile } from "./document.upload.js";
import { findDocumentTypeById } from "../workforce-config/workforce-config.repository.js";
import { uploadDocumentQuerySchema, verifyDocumentSchema, requestDocumentSchema, expiringQuerySchema } from "./documents.validation.js";

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

export const list = asyncHandler(async (req, res) => {
  const rows = await service.listDocuments(req.user, targetEmployeeId(req));
  res.status(200).json({ success: true, data: rows });
});

export const versions = asyncHandler(async (req, res) => {
  const rows = await service.listVersions(req.user, targetEmployeeId(req), req.params.documentTypeId);
  res.status(200).json({ success: true, data: rows });
});

export const upload = asyncHandler(async (req, res) => {
  const input = parseBody(uploadDocumentQuerySchema, req.body);
  const docType = await findDocumentTypeById(input.documentTypeId);
  const file = extractDocumentFile(req, docType?.allowed_mime_types || []);

  const created = await service.uploadDocument(req.user, targetEmployeeId(req), input.documentTypeId, file, {
    expiryDate: input.expiryDate,
  });
  res.status(201).json({ success: true, data: created });
});

export const download = asyncHandler(async (req, res) => {
  const { buffer, mimeType, filename } = await service.downloadDocument(req.user, req.params.documentId);
  res.set({
    "Content-Type": mimeType,
    "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
    "Cache-Control": "private, no-store",
  });
  res.status(200).send(buffer);
});

export const verify = asyncHandler(async (req, res) => {
  const input = parseBody(verifyDocumentSchema, req.body);
  const updated = await service.verifyDocument(req.user, req.params.documentId, input);
  res.status(200).json({ success: true, data: updated });
});

export const requestDocument = asyncHandler(async (req, res) => {
  const input = parseBody(requestDocumentSchema, req.body);
  const created = await service.requestDocument(req.user, targetEmployeeId(req), input.documentTypeId, input.note);
  res.status(201).json({ success: true, data: created });
});

export const pendingRequests = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.pendingRequestsFor(req.user, targetEmployeeId(req)) });
});

export const cancelRequest = asyncHandler(async (req, res) => {
  await service.cancelDocumentRequest(req.user, targetEmployeeId(req), req.params.requestId);
  res.status(204).send();
});

export const expiring = asyncHandler(async (req, res) => {
  const input = parseBody(expiringQuerySchema, req.query);
  res.status(200).json({ success: true, data: await service.listExpiringDocuments(req.user, input.withinDays) });
});
