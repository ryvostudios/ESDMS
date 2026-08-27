import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError } from "../../shared/errors/app-error.js";
import * as service from "./receiving.service.js";
import {
  receiptListQuerySchema,
  receivingQueueQuerySchema,
  recordReceiptSchema,
} from "./receiving.validation.js";

function parse(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError("Invalid request.", parsed.error.flatten());
  return parsed.data;
}

export const listDeliveries = asyncHandler(async (req, res) => {
  const query = parse(receivingQueueQuerySchema, req.query);
  const { rows, total } = await service.listOpenDeliveries(req.user, query);
  res.status(200).json({ success: true, data: rows, meta: { page: query.page, pageSize: query.pageSize, total } });
});

export const deliveryDetail = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.getDeliveryForReceiving(req.user, req.params.id) });
});

export const listReceipts = asyncHandler(async (req, res) => {
  const query = parse(receiptListQuerySchema, req.query);
  const { rows, total } = await service.listReceipts(req.user, query);
  res.status(200).json({ success: true, data: rows, meta: { page: query.page, pageSize: query.pageSize, total } });
});

export const receiptDetail = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.getReceiptDetail(req.user, req.params.id) });
});

export const recordReceipt = asyncHandler(async (req, res) => {
  const input = parse(recordReceiptSchema, req.body);
  res.status(201).json({ success: true, data: await service.recordReceipt(req.user, req.params.id, input) });
});

export const acknowledgeHandover = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.acknowledgeHandover(req.user, req.params.id) });
});

export const confirmReceipt = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await service.confirmReceipt(req.user, req.params.id) });
});
