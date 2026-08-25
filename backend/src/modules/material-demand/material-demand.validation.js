import { z } from "zod";
import { MATERIAL_DEMAND_STATUS } from "./material-demand.constants.js";

const uuid = z.string().uuid();
const STATUSES = Object.values(MATERIAL_DEMAND_STATUS);

const lineSchema = z.object({
  catalogEntryId: uuid,
  quantity: z.number().positive().max(1_000_000),
  note: z.string().trim().max(500).optional().nullable(),
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

export const listQuerySchema = z.object({
  departmentId: uuid.optional(),
  status: z.enum(STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
});
