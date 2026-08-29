import { z } from "zod";
import { optionalQueryValue } from "../../shared/http/query-validation.js";

const uuid = z.string().uuid();

export const listQuerySchema = z.object({
  departmentId: optionalQueryValue(uuid),
  search: optionalQueryValue(z.string().trim().max(100)),
  includeInactive: optionalQueryValue(z.enum(["true", "false"])).default("false"),
  page: optionalQueryValue(z.coerce.number().int().min(1).max(10_000)).default(1),
  pageSize: optionalQueryValue(z.coerce.number().int().min(1).max(100)).default(50),
}).strict();

export const searchItemsQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  departmentId: optionalQueryValue(uuid),
}).strict();

const newItemSchema = z.object({
  name: z.string().trim().min(1).max(150),
  description: z.string().trim().max(1000).optional().nullable(),
});

export const createCatalogEntrySchema = z
  .object({
    departmentId: uuid.optional(),
    defaultUomId: uuid,
    companyItemId: uuid.optional(),
    newItem: newItemSchema.optional(),
  })
  .refine((data) => Boolean(data.companyItemId) !== Boolean(data.newItem), {
    message: "Provide exactly one of companyItemId or newItem.",
    path: ["companyItemId"],
  });

export const updateCatalogEntrySchema = z.object({
  defaultUomId: uuid.optional(),
  isActive: z.boolean().optional(),
});

export const updateCompanyItemSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "Provide at least one change." });
