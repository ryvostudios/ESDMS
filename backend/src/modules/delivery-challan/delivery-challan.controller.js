import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError } from "../../shared/errors/app-error.js";
import * as service from "./delivery-challan.service.js";
import {
  cancelDcSchema,
  createDcSchema,
  dcListQuerySchema,
  updateDcSchema,
} from "./delivery-challan.validation.js";

function parse(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError("Invalid request.", parsed.error.flatten());
  return parsed.data;
}

export const list = asyncHandler(async (req, res) => {
  const query = parse(dcListQuerySchema, req.query);
  const { rows, total } = await service.listDeliveryChallans(req.user, query);
  res.status(200).json({ success: true, data: rows, meta: { page: query.page, pageSize: query.pageSize, total } });
});

export const detail = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.getDcDetail(req.user, req.params.id) });
});

export const create = asyncHandler(async (req, res) => {
  const input = parse(createDcSchema, req.body);
  res.status(201).json({ success: true, data: await service.createDeliveryChallan(req.user, input) });
});

export const update = asyncHandler(async (req, res) => {
  const input = parse(updateDcSchema, req.body);
  res.status(200).json({ success: true, data: await service.updateDraft(req.user, req.params.id, input) });
});

export const finalize = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.finalizeDeliveryChallan(req.user, req.params.id) });
});

export const cancel = asyncHandler(async (req, res) => {
  const input = parse(cancelDcSchema, req.body);
  res.status(200).json({ success: true, data: await service.cancelDeliveryChallan(req.user, req.params.id, input) });
});

export const downloadPdf = asyncHandler(async (req, res) => {
  const { buffer, filename } = await service.generatePdf(req.user, req.params.id);
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "private, no-store",
  });
  res.status(200).send(buffer);
});
