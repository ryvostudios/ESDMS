import { z } from "zod";
import { GATE_PASS_PURPOSES, GATE_PASS_STATUS } from "./gate-pass.constants.js";
import { optionalQueryValue } from "../../shared/http/query-validation.js";

const GATE_PASS_STATUSES = Object.values(GATE_PASS_STATUS);

const uuid = z.string().uuid();

const itemSchema = z.object({
  description: z.string().trim().min(1).max(300),
  partNumber: z.string().trim().max(100).optional().nullable(),
  quantity: z.number().positive().max(1_000_000),
  unit: z.string().trim().max(30).optional().nullable(),
});

// Driver and Vehicle may be given either as a master-data selection
// (driverId / vehicleId) or as free text. Selecting a master row is
// preferred and, when present, the server derives the stored name/phone/
// registration from it — see gate-pass.service.js applyFleetSelection. The
// free-text path is deliberately kept: a one-off visitor vehicle at the gate
// must not require creating permanent master data first.
const gatePassBaseShape = {
  issuingDepartmentId: uuid,
  requestedBy: z.string().trim().min(1).max(150),
  destination: z.string().trim().min(1).max(200),
  driverId: uuid.nullable().optional(),
  vehicleId: uuid.nullable().optional(),
  driverName: z.string().trim().min(1).max(150).optional(),
  driverPhone: z.string().trim().min(5).max(30).optional(),
  vehicleRegistration: z.string().trim().min(1).max(30).optional(),
  jobOrderId: z.string().trim().max(50).optional().nullable(),
  purpose: z.enum(GATE_PASS_PURPOSES),
  expectedReturnDate: z.string().date().optional().nullable(),
  remarks: z.string().trim().max(1000).optional().nullable(),
  items: z.array(itemSchema).min(1).max(50),
};

export const createGatePassSchema = z.object(gatePassBaseShape).superRefine((value, ctx) => {
  if (!value.driverId && (!value.driverName || !value.driverPhone)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["driverId"],
      message: "Select a driver, or provide a driver name and phone.",
    });
  }
  if (!value.vehicleId && !value.vehicleRegistration) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["vehicleId"],
      message: "Select a vehicle, or provide a vehicle registration.",
    });
  }
});

// A draft edit sends only what changed, so the create-time "driver present
// somehow" rule cannot apply here — the stored row already satisfies it.
export const updateDraftSchema = z.object(gatePassBaseShape).partial();

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
  status: optionalQueryValue(z.enum(GATE_PASS_STATUSES)),
  search: optionalQueryValue(z.string().trim().max(100)),
  page: optionalQueryValue(z.coerce.number().int().min(1).max(10_000)).default(1),
  pageSize: optionalQueryValue(z.coerce.number().int().min(1).max(100)).default(20),
}).strict();

export const guardSearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(100),
}).strict();

export const guardVerifySchema = z.object({
  token: z.string().trim().min(1).max(200),
});

export const addEvidenceSchema = z.object({
  kind: z.enum(["OUTBOUND", "INBOUND", "INBOUND_ADDITIONAL"]),
  note: z.string().trim().min(1).max(300).optional().nullable(),
});

export const uuidParam = uuid;
