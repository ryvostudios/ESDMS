import { z } from "zod";

export const createPolicySchema = z.object({
  name: z.string().trim().min(1).max(100),
  workDays: z.number().int().min(1),
  offDays: z.number().int().min(0),
});

export const updatePolicySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
});

export const adjustSchema = z.object({
  days: z.number().refine((n) => n !== 0, "Adjustment cannot be zero."),
  reason: z.string().trim().max(500),
  effectiveDate: z.string().date(),
});
