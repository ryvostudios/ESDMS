import { z } from "zod";
import { MATERIAL_DEMAND_STATUS } from "./material-demand.constants.js";
import { optionalQueryValue } from "../../shared/http/query-validation.js";

const uuid = z.string().uuid();
const STATUSES = Object.values(MATERIAL_DEMAND_STATUS);

// A line may declare that part of what it asks for is carried forward from a
// specific unresolved earlier requirement. Declaring it does NOT claim the
// quantity — the authoritative claim is made at submit (see
// carry-forward.service.js), so an abandoned draft never holds anything.
const carryForwardSchema = z
  .object({
    sourceType: z.enum(["UNPURCHASED_IPO_QUANTITY", "OUT_OF_BUDGET", "RECEIVING_SHORTAGE"]),
    sourceId: uuid,
    quantity: z.number().positive().max(1_000_000),
  })
  .strict();

const lineSchema = z.object({
  catalogEntryId: uuid,
  quantity: z.number().positive().max(1_000_000),
  note: z.string().trim().max(500).optional().nullable(),
  carryForward: carryForwardSchema.optional().nullable(),
});

function noDuplicateLines(data) {
  return new Set(data.lines?.map((line) => line.catalogEntryId)).size === (data.lines?.length ?? 0);
}

const DUPLICATE_LINE_ISSUE = {
  message: "The same material cannot appear twice in one Demand.",
  path: ["lines"],
};

// A Draft may legitimately have zero lines while it's being built (the
// user unchecks everything, or hasn't picked anything yet) — "at least one
// line" is enforced at submit time only (see material-demand.service.js),
// not here.
export const createDemandSchema = z
  .object({
    departmentId: uuid.optional(),
    note: z.string().trim().max(1000).optional().nullable(),
    lines: z.array(lineSchema).max(200),
  })
  .refine(noDuplicateLines, DUPLICATE_LINE_ISSUE);

// Department is deliberately not editable after creation — a line is
// ownership-pinned to a specific department via a composite FK (see the
// migration), so changing it would require re-validating/re-pinning every
// existing line rather than a plain field update.
export const updateDraftSchema = z
  .object({
    note: z.string().trim().max(1000).optional().nullable(),
    lines: z.array(lineSchema).max(200).optional(),
  })
  .refine(noDuplicateLines, DUPLICATE_LINE_ISSUE);

// Reason is required to reject (no strong existing-convention override for
// this case — matches Gate Pass's reject/cancel, which also require one),
// optional on approval.
export const decisionSchema = z
  .object({
    decision: z.enum(["APPROVED", "REJECTED"]),
    reason: z.string().trim().max(1000).optional().nullable(),
  })
  .refine((data) => data.decision !== "REJECTED" || Boolean(data.reason?.trim()), {
    message: "A reason is required to reject.",
    path: ["reason"],
  });

export const finalDecisionSchema = decisionSchema.and(
  z.object({
    pricingId: uuid,
  }),
);

export const listQuerySchema = z.object({
  departmentId: optionalQueryValue(uuid),
  status: optionalQueryValue(z.enum(STATUSES)),
  search: optionalQueryValue(z.string().trim().max(100)),
  page: optionalQueryValue(z.coerce.number().int().min(1).max(10_000)).default(1),
  pageSize: optionalQueryValue(z.coerce.number().int().min(1).max(100)).default(20),
}).strict();

// Line-level final purchasing disposition. An EXCLUDED line must name a
// category; the free-text explanation is mandatory only for OTHER, where the
// category alone says nothing.
export const lineDispositionSchema = z
  .object({
    demandLineId: uuid,
    disposition: z.enum(["APPROVED_FOR_PURCHASE", "EXCLUDED"]),
    exclusionCategory: z
      .enum(["OUT_OF_BUDGET", "NOT_REQUIRED_NOW", "ALREADY_AVAILABLE", "DUPLICATE", "OTHER"])
      .nullable()
      .optional(),
    reason: z.string().trim().max(1000).nullable().optional(),
  })
  .strict()
  .refine((line) => (line.disposition === "EXCLUDED") === Boolean(line.exclusionCategory), {
    message: "An excluded line must name an exclusion category, and an approved line must not.",
    path: ["exclusionCategory"],
  })
  .refine((line) => line.exclusionCategory !== "OTHER" || Boolean(line.reason?.trim()), {
    message: "An explanation is required when the exclusion category is OTHER.",
    path: ["reason"],
  });

export const setLineDispositionsSchema = z
  .object({
    pricingId: uuid,
    lines: z.array(lineDispositionSchema).min(1).max(200),
  })
  .strict()
  .refine((data) => new Set(data.lines.map((line) => line.demandLineId)).size === data.lines.length, {
    message: "A Demand line cannot receive two purchasing decisions in one request.",
    path: ["lines"],
  });
