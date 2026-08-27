// Mirrors backend/src/modules/material-demand/material-demand.constants.js —
// kept in sync manually, same convention as the Gate Pass module's own
// constants.js.
export const MATERIAL_DEMAND_STATUSES = [
  "DRAFT",
  "PENDING_INITIAL_REVIEW",
  "REJECTED",
  "READY_FOR_PRICING",
  "PENDING_FINAL_APPROVAL",
  "PRICING_REVISION_REQUIRED",
  "READY_FOR_IPO",
  "IPO_GENERATED",
  "IPO_CANCELLED",
  "COMPLETED",
];

export const STATUS_TONE = {
  DRAFT: "neutral",
  PENDING_INITIAL_REVIEW: "warning",
  REJECTED: "danger",
  READY_FOR_PRICING: "success",
  PENDING_FINAL_APPROVAL: "warning",
  PRICING_REVISION_REQUIRED: "danger",
  READY_FOR_IPO: "success",
  IPO_GENERATED: "info",
  IPO_CANCELLED: "danger",
  COMPLETED: "success",
};

export const APPROVAL_TYPE_LABEL = {
  MANAGEMENT_REVIEW: "Management Review",
  FORMAL_APPROVAL: "Formal Approval",
};
