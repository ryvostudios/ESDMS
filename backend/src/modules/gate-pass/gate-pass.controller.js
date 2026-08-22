import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError } from "../../shared/errors/app-error.js";
import * as service from "./gate-pass.service.js";
import { toDetailDto } from "./gate-pass.serializers.js";
import {
  createGatePassSchema,
  updateDraftSchema,
  reasonSchema,
  listQuerySchema,
} from "./gate-pass.validation.js";

function parseBody(schema, body) {
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new ValidationError("Invalid request.", parsed.error.flatten());
  }

  return parsed.data;
}

export const create = asyncHandler(async (req, res) => {
  const input = parseBody(createGatePassSchema, req.body);
  const id = await service.createGatePass(req.user, input);
  const detail = await service.getGatePassDetail(req.user, id);

  res.status(201).json({ success: true, data: toDetailDto(detail.gatePass, detail.items, detail.auditLog, detail.documentReady) });
});

export const list = asyncHandler(async (req, res) => {
  const filters = parseBody(listQuerySchema, req.query);
  const { rows, total } = await service.listGatePasses(req.user, filters);

  res.status(200).json({
    success: true,
    data: rows.map((row) => toDetailDto(row)),
    meta: { page: filters.page, pageSize: filters.pageSize, total },
  });
});

export const detail = asyncHandler(async (req, res) => {
  const result = await service.getGatePassDetail(req.user, req.params.id);
  res.status(200).json({ success: true, data: toDetailDto(result.gatePass, result.items, result.auditLog, result.documentReady) });
});

export const updateDraft = asyncHandler(async (req, res) => {
  const input = parseBody(updateDraftSchema, req.body);
  await service.updateDraft(req.user, req.params.id, input);
  const result = await service.getGatePassDetail(req.user, req.params.id);

  res.status(200).json({ success: true, data: toDetailDto(result.gatePass, result.items, result.auditLog, result.documentReady) });
});

async function respondWithDetail(req, res, statusCode = 200) {
  const result = await service.getGatePassDetail(req.user, req.params.id);
  res.status(statusCode).json({ success: true, data: toDetailDto(result.gatePass, result.items, result.auditLog, result.documentReady) });
}

export const submit = asyncHandler(async (req, res) => {
  await service.submitGatePass(req.user, req.params.id);
  await respondWithDetail(req, res);
});

export const approve = asyncHandler(async (req, res) => {
  await service.approveGatePass(req.user, req.params.id);
  await respondWithDetail(req, res);
});

export const reject = asyncHandler(async (req, res) => {
  const { reason } = parseBody(reasonSchema, req.body);
  await service.rejectGatePass(req.user, req.params.id, reason);
  await respondWithDetail(req, res);
});

export const cancel = asyncHandler(async (req, res) => {
  const { reason } = parseBody(reasonSchema, req.body);
  await service.cancelGatePass(req.user, req.params.id, reason);
  await respondWithDetail(req, res);
});

export const downloadPdf = asyncHandler(async (req, res) => {
  const { buffer, mimeType } = await service.getLatestPdf(req.user, req.params.id);
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "private, no-store");
  res.send(buffer);
});

export const downloadFile = asyncHandler(async (req, res) => {
  const { buffer, mimeType } = await service.getAuthorizedFile(req.user, req.params.id, req.params.fileId);
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(buffer);
});
