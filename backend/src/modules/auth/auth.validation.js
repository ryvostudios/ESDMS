import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(200),
});
