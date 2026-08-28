import { z } from "zod";
import { optionalQueryValue } from "../../shared/http/query-validation.js";

export const expiringQuerySchema = z.object({
  withinDays: optionalQueryValue(z.coerce.number().int().min(0).max(365)).default(30),
}).strict();

export const uploadDocumentQuerySchema = z.object({
  documentTypeId: z.string().uuid(),
  expiryDate: optionalQueryValue(z.string().date()),
}).strict();

export const verifyDocumentSchema = z.object({
  status: z.enum(["VERIFIED", "NEEDS_REPLACEMENT"]),
  remark: z.string().trim().max(500).optional(),
});

export const requestDocumentSchema = z.object({
  documentTypeId: z.string().uuid(),
  note: z.string().trim().max(500).optional(),
});
