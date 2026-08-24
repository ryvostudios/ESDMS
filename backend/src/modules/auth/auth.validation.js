import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(200),
  // Strict boolean — not coerced — so a stray string/number is a
  // validation error, not silently treated as truthy/falsy.
  rememberMe: z.boolean().optional().default(false),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(12, "Password must be at least 12 characters.").max(200),
});
