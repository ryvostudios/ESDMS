import { z } from "zod";

export const createPositionSchema = z.object({
  code: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(150),
  departmentId: z.string().uuid().optional().nullable(),
  description: z.string().trim().max(2000).optional(),
  siteId: z.string().uuid().optional(),
});

export const updatePositionSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  departmentId: z.string().uuid().optional().nullable(),
  description: z.string().trim().max(2000).optional().nullable(),
  isActive: z.boolean().optional(),
});
