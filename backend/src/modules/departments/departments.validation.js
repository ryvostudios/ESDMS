import { z } from "zod";

export const createDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(100),
  siteId: z.string().uuid().optional(),
});

export const updateDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
});
