import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError } from "../../shared/errors/app-error.js";
import {
  listQuerySchema,
  searchItemsQuerySchema,
  createCatalogEntrySchema,
  updateCatalogEntrySchema,
} from "./material-catalog.validation.js";
import * as service from "./material-catalog.service.js";

function parseBody(schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid request.", parsed.error.flatten());
  return parsed.data;
}

export const listUnitsOfMeasure = asyncHandler(async (req, res) => {
  const rows = await service.listUnitsOfMeasure();
  res.status(200).json({ success: true, data: rows });
});

export const list = asyncHandler(async (req, res) => {
  const query = parseBody(listQuerySchema, req.query);
  const { rows, total } = await service.listCatalog(req.user, query);
  res.status(200).json({ success: true, data: rows, meta: { page: query.page, pageSize: query.pageSize, total } });
});

export const searchItems = asyncHandler(async (req, res) => {
  const query = parseBody(searchItemsQuerySchema, req.query);
  const rows = await service.searchItems(req.user, query);
  res.status(200).json({ success: true, data: rows });
});

export const create = asyncHandler(async (req, res) => {
  const input = parseBody(createCatalogEntrySchema, req.body);
  const { entry, companyItem, possibleDuplicates } = await service.createCatalogEntry(req.user, input);
  res.status(201).json({
    success: true,
    data: { ...entry, companyItem },
    ...(possibleDuplicates.length > 0 && { meta: { possibleDuplicates } }),
  });
});

export const update = asyncHandler(async (req, res) => {
  const input = parseBody(updateCatalogEntrySchema, req.body);
  const updated = await service.updateCatalogEntry(req.user, req.params.id, input);
  res.status(200).json({ success: true, data: updated });
});
