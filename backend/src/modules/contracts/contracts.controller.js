import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError, NotFoundError } from "../../shared/errors/app-error.js";
import * as service from "./contracts.service.js";
import { extractDocumentFile } from "../documents/document.upload.js";
import { createDraftSchema, updateDraftSchema, transitionSchema } from "./contracts.validation.js";

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
  res.status(200).json({ success: true, data: await service.listContracts(req.user, targetEmployeeId(req)) });
});

export const detail = asyncHandler(async (req, res) => {
  const contract = await service.getContract(req.user, targetEmployeeId(req), req.params.contractId);
  res.status(200).json({ success: true, data: contract });
});

export const createDraft = asyncHandler(async (req, res) => {
  const input = parseBody(createDraftSchema, req.body);
  const created = await service.createDraft(req.user, targetEmployeeId(req), input);
  res.status(201).json({ success: true, data: created });
});

export const updateDraft = asyncHandler(async (req, res) => {
  const input = parseBody(updateDraftSchema, req.body);
  const updated = await service.updateDraftMetadata(req.user, targetEmployeeId(req), req.params.contractId, input);
  res.status(200).json({ success: true, data: updated });
});

export const uploadDraftFile = asyncHandler(async (req, res) => {
  const file = extractDocumentFile(req, ["application/pdf"]);
  const updated = await service.uploadDraftFile(req.user, targetEmployeeId(req), req.params.contractId, file);
  res.status(200).json({ success: true, data: updated });
});

export const finalize = asyncHandler(async (req, res) => {
  const finalized = await service.finalizeContract(req.user, targetEmployeeId(req), req.params.contractId);
  res.status(200).json({ success: true, data: finalized });
});

export const transition = asyncHandler(async (req, res) => {
  const input = parseBody(transitionSchema, req.body);
  const updated = await service.transitionContract(req.user, targetEmployeeId(req), req.params.contractId, input);
  res.status(200).json({ success: true, data: updated });
});

export const remove = asyncHandler(async (req, res) => {
  await service.deleteDraftContract(req.user, targetEmployeeId(req), req.params.contractId);
  res.status(204).send();
});

export const download = asyncHandler(async (req, res) => {
  const { buffer, mimeType, contractNumber } = await service.downloadContract(req.user, targetEmployeeId(req), req.params.contractId);
  res.set({
    "Content-Type": mimeType,
    "Content-Disposition": `attachment; filename="${contractNumber}.pdf"`,
    "Cache-Control": "private, no-store",
  });
  res.status(200).send(buffer);
});
