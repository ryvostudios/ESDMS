import { z } from "zod";

export const createDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(100),
  siteId: z.string().uuid().optional(),
});

export const updateDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
  // Where this department's finalized Delivery Challans are shared over the
  // official WhatsApp Business Platform. Null clears it, falling the
  // department back to the configured default destination. Constrained to
  // the same character set the database CHECK enforces — never free text.
  whatsappDestination: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9+@._-]{5,40}$/, "Enter a valid WhatsApp destination identifier.")
    .nullable()
    .optional(),
});
