import { z } from "zod";
import { DC_STATUS } from "./delivery-challan.constants.js";

const uuid = z.string().uuid();

const exactQuantity = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/, "Quantity must be a plain decimal with at most two decimal places.")
  .refine((value) => Number(value) > 0, "Quantity must be greater than zero.");

const dcLineSchema = z
  .object({
    ipoLineId: uuid,
    quantity: exactQuantity,
  })
  .strict();

const noDuplicateLines = (data) =>
  new Set(data.lines?.map((line) => line.ipoLineId)).size === (data.lines?.length ?? 0);

export const createDcSchema = z
  .object({
    // Stable per LOGICAL shipment. A retried creation is answered with the
    // challan that already exists, so a lost response can never cut a second
    // challan — or consume a second DC number — for one shipment.
    operationId: uuid,
    ipoId: uuid,
    note: z.string().trim().max(1000).nullable().optional(),
    lines: z.array(dcLineSchema).min(1).max(200),
  })
  .strict()
  .refine(noDuplicateLines, { message: "An IPO line cannot appear twice on one Delivery Challan.", path: ["lines"] });

export const updateDcSchema = z
  .object({
    note: z.string().trim().max(1000).nullable().optional(),
    lines: z.array(dcLineSchema).min(1).max(200).optional(),
  })
  .strict()
  .refine(noDuplicateLines, { message: "An IPO line cannot appear twice on one Delivery Challan.", path: ["lines"] });

export const cancelDcSchema = z
  .object({
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

export const dcListQuerySchema = z
  .object({
    ipoId: uuid.optional(),
    departmentId: uuid.optional(),
    status: z.enum(Object.values(DC_STATUS)).optional(),
    search: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
  })
  .strict();
