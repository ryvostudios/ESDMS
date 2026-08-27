import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError } from "../../shared/errors/app-error.js";
import * as service from "./ipo.service.js";
import {
  cancelIpoSchema,
  ipoListQuerySchema,
  outstandingQuerySchema,
  recordPurchaseSchema,
} from "./ipo.validation.js";

function parse(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError("Invalid request.", parsed.error.flatten());
  return parsed.data;
}

export const list = asyncHandler(async (req, res) => {
  const query = parse(ipoListQuerySchema, req.query);
  const { rows, total } = await service.listIpos(req.user, query);
  res.status(200).json({ success: true, data: rows, meta: { page: query.page, pageSize: query.pageSize, total } });
});

export const detail = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.getIpoDetail(req.user, req.params.id) });
});

export const acknowledge = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.acknowledgeIpo(req.user, req.params.id) });
});

export const recordPurchase = asyncHandler(async (req, res) => {
  const input = parse(recordPurchaseSchema, req.body);
  res.status(200).json({ success: true, data: await service.recordPurchase(req.user, req.params.id, input) });
});

export const closePurchasing = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.closePurchasing(req.user, req.params.id) });
});

export const cancel = asyncHandler(async (req, res) => {
  const input = parse(cancelIpoSchema, req.body);
  res.status(200).json({ success: true, data: await service.cancelIpo(req.user, req.params.id, input) });
});

export const outstanding = asyncHandler(async (req, res) => {
  const query = parse(outstandingQuerySchema, req.query);
  res.status(200).json({ success: true, data: await service.listOutstandingCarryForward(req.user, query) });
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
