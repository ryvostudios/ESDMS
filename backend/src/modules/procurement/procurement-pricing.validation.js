import { z } from "zod";
import { PRICING_CURRENCY } from "./procurement-pricing.constants.js";

const uuid = z.string().uuid();
const exactPrice = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/, "Price must be a plain decimal with at most two decimal places.")
  .refine((value) => !/^0(?:\.0{1,2})?$/.test(value), "Price must be greater than zero.");

const pricingLineSchema = z
  .object({
    demandLineId: uuid,
    estimatedUnitPrice: exactPrice,
    procurementNote: z.string().trim().max(1000).optional().nullable(),
  })
  .strict();

export const savePricingSchema = z
  .object({
    revision: z.number().int().positive(),
    pricingVersion: z.number().int().positive(),
    currency: z.literal(PRICING_CURRENCY),
    lines: z.array(pricingLineSchema).max(200),
  })
  .strict()
  .refine(
    (data) => new Set(data.lines.map((line) => line.demandLineId)).size === data.lines.length,
    { message: "A Demand line cannot be priced twice.", path: ["lines"] },
  );

export const submitPricingSchema = z
  .object({
    revision: z.number().int().positive(),
    pricingVersion: z.number().int().positive(),
  })
  .strict();

export const startRepricingSchema = z
  .object({
    revision: z.number().int().positive(),
  })
  .strict();

export const pricingDetailQuerySchema = z
  .object({
    version: z.coerce.number().int().positive().optional(),
  })
  .strict();

export const pricingQueueQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
  })
  .strict();
