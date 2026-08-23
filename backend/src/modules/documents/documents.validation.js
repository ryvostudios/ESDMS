import { z } from "zod";

export const expiringQuerySchema = z.object({
  withinDays: z.coerce.number().int().min(0).max(365).default(30),
});

export const uploadDocumentQuerySchema = z.object({
  documentTypeId: z.string().uuid(),
  expiryDate: z.string().date().optional(),
});

export const verifyDocumentSchema = z.object({
  status: z.enum(["VERIFIED", "NEEDS_REPLACEMENT"]),
  remark: z.string().trim().max(500).optional(),
});

export const requestDocumentSchema = z.object({
  documentTypeId: z.string().uuid(),
  note: z.string().trim().max(500).optional(),
});
