import { z } from "zod";

export const createDraftSchema = z.object({
  kind: z.enum(["ORIGINAL", "AMENDMENT"]),
  amendsContractId: z.string().uuid().optional(),
  effectiveStartDate: z.string().date().optional(),
  termsSummary: z.string().trim().max(5000).optional(),
});

export const updateDraftSchema = z.object({
  effectiveStartDate: z.string().date().optional(),
  termsSummary: z.string().trim().max(5000).optional(),
});

export const transitionSchema = z.object({
  status: z.enum(["SUPERSEDED", "EXPIRED", "TERMINATED"]),
});
