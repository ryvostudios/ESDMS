import { z } from "zod";
import { CANCELLATION_CATEGORIES, IPO_STATUS } from "./ipo.constants.js";

const uuid = z.string().uuid();

// Money and quantities cross the wire as exact decimal STRINGS and are stored
// as PostgreSQL numeric — never JavaScript floats (spec §31). The regexes
// also exclude NaN/Infinity, which numeric would otherwise accept.
const exactPrice = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/, "Price must be a plain decimal with at most two decimal places.")
  .refine((value) => !/^0(?:\.0{1,2})?$/.test(value), "Price must be greater than zero.");

// A purchase EVENT quantity: positive to record a purchase, negative to
// correct an earlier one. Never zero — that would assert nothing.
const eventQuantity = z
  .string()
  .regex(
    /^-?(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/,
    "Quantity must be a plain decimal with at most two decimal places.",
  )
  .refine((value) => Number(value) !== 0, "Quantity must not be zero.");

// A PURCHASE: the amount bought in THIS event, at THIS price — not a running
// total. One line legitimately gets several events at different prices, and a
// single cumulative quantity + "the" price could not represent that without
// destroying the earlier transaction.
const purchaseEntrySchema = z
  .object({
    ipoLineId: uuid,
    quantity: eventQuantity.refine((value) => Number(value) > 0, "A purchase quantity must be positive."),
    actualUnitPrice: exactPrice,
    procurementNote: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

// A REVERSAL: undoes part or all of one specific earlier purchase.
//
// It deliberately accepts NO price. A correction is not a new commercial
// decision — it withdraws an earlier one — so its value is the value that was
// originally booked. The server reads that from the referenced event, which is
// what makes "reverse 60 bought at 100" arithmetically impossible to record as
// "-60 at 1". A reason is required, because a correction that does not say why
// is not an audit trail.
const reversalEntrySchema = z
  .object({
    ipoLineId: uuid,
    quantity: eventQuantity.refine((value) => Number(value) < 0, "A reversal quantity must be negative."),
    reversesPurchaseEventId: uuid,
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

export const purchaseLineSchema = z.union([purchaseEntrySchema, reversalEntrySchema]);

// Idempotency comes from the operation id rather than from absoluteness: a
// retried request carries the same value and books nothing new, while a
// genuinely separate purchase carries a new one.
export const recordPurchaseSchema = z
  .object({
    operationId: uuid,
    lines: z.array(purchaseLineSchema).min(1).max(200),
  })
  .strict()
  .refine((data) => new Set(data.lines.map((line) => line.ipoLineId)).size === data.lines.length, {
    message: "An IPO line cannot appear twice in one purchase operation.",
    path: ["lines"],
  });

export const cancelIpoSchema = z
  .object({
    category: z.enum(CANCELLATION_CATEGORIES).optional(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

export const ipoListQuerySchema = z
  .object({
    departmentId: uuid.optional(),
    status: z.enum(Object.values(IPO_STATUS)).optional(),
    search: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
  })
  .strict();

export const outstandingQuerySchema = z
  .object({
    departmentId: uuid.optional(),
    catalogEntryIds: z
      .union([uuid, z.array(uuid).max(200)])
      .transform((value) => (Array.isArray(value) ? value : [value])),
  })
  .strict();
