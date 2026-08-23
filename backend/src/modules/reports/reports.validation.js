import { z } from "zod";

export const reportQuerySchema = z.object({
  siteId: z.string().uuid().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  withinDays: z.coerce.number().int().min(0).max(365).default(30),
});

export const bulkExportSchema = z.object({
  siteId: z.string().uuid().optional(),
  employeeIds: z.array(z.string().uuid()).max(250).optional(),
  includeContracts: z.boolean().default(false),
});
