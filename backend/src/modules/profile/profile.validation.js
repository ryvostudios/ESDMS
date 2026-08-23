import { z } from "zod";

export const updatePersonalDetailsSchema = z.object({
  cnic: z.string().trim().max(20).optional(),
  mobile: z.string().trim().max(30).optional(),
  address: z.string().trim().max(1000).optional(),
  personalEmail: z.string().trim().email().optional(),
});

export const emergencyContactSchema = z.object({
  name: z.string().trim().min(1).max(150),
  relationship: z.string().trim().max(60).optional(),
  phone: z.string().trim().min(1).max(30),
  alternatePhone: z.string().trim().max(30).optional(),
  sortOrder: z.number().int().optional(),
});

export const updateEmergencyContactSchema = emergencyContactSchema.partial();

export const customFieldValueSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
});
