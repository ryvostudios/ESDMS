import { z } from "zod";
import { GATE_PASS_PURPOSES } from "./gate-pass.constants.js";

const uuid = z.string().uuid();

const itemSchema = z.object({
  description: z.string().trim().min(1).max(300),
  partNumber: z.string().trim().max(100).optional().nullable(),
  quantity: z.number().positive().max(1_000_000),
  unit: z.string().trim().max(30).optional().nullable(),
});

export const createGatePassSchema = z.object({
  issuingDepartmentId: uuid,
  requestedBy: z.string().trim().min(1).max(150),
  destination: z.string().trim().min(1).max(200),
  driverName: z.string().trim().min(1).max(150),
  driverPhone: z.string().trim().min(5).max(30),
  vehicleRegistration: z.string().trim().min(1).max(30),
  jobOrderId: z.string().trim().max(50).optional().nullable(),
  purpose: z.enum(GATE_PASS_PURPOSES),
  expectedReturnDate: z.string().date().optional().nullable(),
  remarks: z.string().trim().max(1000).optional().nullable(),
  items: z.array(itemSchema).min(1).max(50),
});

export const updateDraftSchema = createGatePassSchema.partial().extend({
  items: z.array(itemSchema).min(1).max(50).optional(),
});

export const reasonSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export const returnActionSchema = z.object({
  odometer: z.coerce.number().int().min(0).max(10_000_000),
  remarks: z.string().trim().max(500).optional().nullable(),
});

export const exitActionSchema = z.object({
  odometer: z.coerce.number().int().min(0).max(10_000_000),
});

export const listQuerySchema = z.object({
  status: z.string().optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export const guardSearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(100),
});

export const uuidParam = uuid;
