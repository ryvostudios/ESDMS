import { z } from "zod";
import { optionalQueryValue } from "../../shared/http/query-validation.js";

const DRIVER_TYPES = ["COMPANY", "CONTRACTOR", "VENDOR"];
const VEHICLE_TYPES = ["TRUCK", "PICKUP", "VAN", "CAR", "BUS", "TRAILER", "BIKE", "OTHER"];

const optionalText = (max) => z.string().trim().max(max).nullable().optional();

export const fleetListQuerySchema = z
  .object({
    search: optionalQueryValue(z.string().trim().max(100)),
    includeInactive: optionalQueryValue(z.enum(["true", "false"])),
    siteId: optionalQueryValue(z.string().uuid()),
  })
  .strict();

export const createDriverSchema = z.object({
  name: z.string().trim().min(1).max(150),
  phone: z.string().trim().min(5).max(30),
  cnic: optionalText(30),
  licenceNumber: optionalText(50),
  // A date only — an expiry is a calendar fact, never a timestamp, so an
  // expiry entered anywhere in the world means the same day.
  licenceExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.").nullable().optional(),
  company: optionalText(150),
  driverType: z.enum(DRIVER_TYPES).optional(),
  employeeId: z.string().uuid().nullable().optional(),
  notes: optionalText(2000),
  siteId: z.string().uuid().optional(),
});

export const updateDriverSchema = createDriverSchema
  .omit({ siteId: true })
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, { message: "Provide at least one change." });

export const createVehicleSchema = z.object({
  registrationNumber: z.string().trim().min(1).max(30),
  vehicleType: z.enum(VEHICLE_TYPES).optional(),
  make: optionalText(60),
  model: optionalText(60),
  color: optionalText(40),
  ownerCompany: optionalText(150),
  notes: optionalText(2000),
  siteId: z.string().uuid().optional(),
});

export const updateVehicleSchema = createVehicleSchema
  .omit({ siteId: true })
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, { message: "Provide at least one change." });
