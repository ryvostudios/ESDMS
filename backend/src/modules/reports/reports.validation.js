import { z } from "zod";
import { optionalQueryValue } from "../../shared/http/query-validation.js";

export const reportQuerySchema = z.object({
  siteId: optionalQueryValue(z.string().uuid()),
  from: optionalQueryValue(z.string().date()),
  to: optionalQueryValue(z.string().date()),
  withinDays: optionalQueryValue(z.coerce.number().int().min(0).max(365)).default(30),
}).strict();

export const bulkExportSchema = z.object({
  siteId: z.string().uuid().optional(),
  employeeIds: z.array(z.string().uuid()).max(250).optional(),
  includeContracts: z.boolean().default(false),
});
