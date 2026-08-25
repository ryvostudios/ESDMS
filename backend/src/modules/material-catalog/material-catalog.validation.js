import { z } from "zod";

const uuid = z.string().uuid();

export const listQuerySchema = z.object({
  departmentId: uuid.optional(),
  search: z.string().trim().max(100).optional(),
  includeInactive: z.enum(["true", "false"]).optional().default("false"),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export const searchItemsQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  departmentId: uuid.optional(),
});

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
