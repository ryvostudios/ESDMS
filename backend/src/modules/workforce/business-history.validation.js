import { z } from "zod";

export const removeHistorySchema = z.object({
  reason: z.string().trim().min(1).max(500),
  confirmPassword: z.string().min(1).max(200),
});
