import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError } from "../../shared/errors/app-error.js";
import { createDemandSchema, updateDraftSchema, listQuerySchema, decisionSchema } from "./material-demand.validation.js";
import * as service from "./material-demand.service.js";

function parseBody(schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid request.", parsed.error.flatten());
  return parsed.data;
}

export const list = asyncHandler(async (req, res) => {
  const query = parseBody(listQuerySchema, req.query);
  const { rows, total } = await service.listDemands(req.user, query);
  res.status(200).json({ success: true, data: rows, meta: { page: query.page, pageSize: query.pageSize, total } });
});

export const create = asyncHandler(async (req, res) => {
  const input = parseBody(createDemandSchema, req.body);
  const id = await service.createDemand(req.user, input);
  const detail = await service.getDemandDetail(req.user, id);
  res.status(201).json({ success: true, data: detail });
});

export const detail = asyncHandler(async (req, res) => {
  const result = await service.getDemandDetail(req.user, req.params.id);
  res.status(200).json({ success: true, data: result });
});

export const updateDraft = asyncHandler(async (req, res) => {
  const input = parseBody(updateDraftSchema, req.body);
  await service.updateDraft(req.user, req.params.id, input);
  const result = await service.getDemandDetail(req.user, req.params.id);
  res.status(200).json({ success: true, data: result });
});

export const submit = asyncHandler(async (req, res) => {
  await service.submitDemand(req.user, req.params.id);
  const result = await service.getDemandDetail(req.user, req.params.id);
  res.status(200).json({ success: true, data: result });
});

export const recordReview = asyncHandler(async (req, res) => {
  const input = parseBody(decisionSchema, req.body);
  await service.recordManagementReview(req.user, req.params.id, input);
  const result = await service.getDemandDetail(req.user, req.params.id);
  res.status(200).json({ success: true, data: result });
});

export const recordApproval = asyncHandler(async (req, res) => {
  const input = parseBody(decisionSchema, req.body);
  await service.recordFormalApproval(req.user, req.params.id, input);
  const result = await service.getDemandDetail(req.user, req.params.id);
  res.status(200).json({ success: true, data: result });
});
