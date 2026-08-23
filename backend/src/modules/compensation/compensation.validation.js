import { z } from "zod";

export const recordCompensationSchema = z.object({
  amount: z.number().min(0),
  currency: z.string().trim().length(3).default("PKR"),
  effectiveDate: z.string().date(),
  reason: z.string().trim().max(500).optional(),
});
