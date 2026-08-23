import { z } from "zod";

export const createTypeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  requiresDocument: z.boolean().optional(),
  tracksBalance: z.boolean().optional(),
  description: z.string().trim().max(500).optional(),
});

export const updateTypeSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  isActive: z.boolean().optional(),
});

export const submitLeaveSchema = z.object({
  leaveTypeId: z.string().uuid(),
  startDate: z.string().date(),
  endDate: z.string().date(),
  requestedDays: z.number().positive(),
  reason: z.string().trim().max(1000).optional(),
});

export const decideLeaveSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  remark: z.string().trim().max(500).optional(),
});
