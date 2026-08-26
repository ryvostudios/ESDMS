import { ValidationError } from "../../shared/errors/app-error.js";
import { asyncHandler } from "../../shared/http/async-handler.js";
import * as service from "./procurement-pricing.service.js";
import {
  pricingQueueQuerySchema,
  savePricingSchema,
  submitPricingSchema,
} from "./procurement-pricing.validation.js";

function parse(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError("Invalid request.", parsed.error.flatten());
  return parsed.data;
}

export const list = asyncHandler(async (req, res) => {
  const query = parse(pricingQueueQuerySchema, req.query);
  const { rows, total } = await service.listPricingQueue(req.user, query);
  res.status(200).json({ success: true, data: rows, meta: { page: query.page, pageSize: query.pageSize, total } });
});

export const detail = asyncHandler(async (req, res) => {
  const result = await service.getPricing(req.user, req.params.demandId);
  res.status(200).json({ success: true, data: result });
});

export const save = asyncHandler(async (req, res) => {
  const input = parse(savePricingSchema, req.body);
  const result = await service.savePricing(req.user, req.params.demandId, input);
  res.status(200).json({ success: true, data: result });
});

export const submit = asyncHandler(async (req, res) => {
  const input = parse(submitPricingSchema, req.body);
  const result = await service.submitPricing(req.user, req.params.demandId, input);
  res.status(200).json({ success: true, data: result });
});

