import { z } from "zod";
import { ASSIGNABLE_ROLES } from "./users.authorization.js";

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(2).max(150),
  password: z.string().min(12, "Password must be at least 12 characters."),
  role: z.enum(ASSIGNABLE_ROLES),
  siteId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional().nullable(),
});

export const changeRoleSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES),
});

export const permissionOverrideSchema = z.object({
  effect: z.enum(["GRANT", "DENY"]),
  reason: z.string().trim().max(500).optional(),
});
