// Mirrors backend/src/modules/ipo/ipo.constants.js — kept in sync by hand,
// the same convention the Gate Pass and Material Demand modules already use.
export const IPO_STATUSES = ["GENERATED", "ACKNOWLEDGED", "PURCHASING", "COMPLETED", "CANCELLED"];

export const IPO_STATUS_TONE = {
  GENERATED: "info",
  ACKNOWLEDGED: "info",
  PURCHASING: "warning",
  COMPLETED: "success",
  CANCELLED: "danger",
};

export const PURCHASE_STATUS_LABEL = {
  NOT_PURCHASED: "Not purchased",
  PARTIALLY_PURCHASED: "Partially purchased",
  PURCHASED: "Purchased",
};

export const PURCHASE_STATUS_TONE = {
  NOT_PURCHASED: "neutral",
  PARTIALLY_PURCHASED: "warning",
  PURCHASED: "success",
};

export const CANCELLATION_CATEGORIES = [
  ["NO_LONGER_REQUIRED", "No longer required"],
  ["BUDGET_WITHDRAWN", "Budget withdrawn"],
  ["DUPLICATE", "Duplicate"],
  ["SUPPLIER_UNAVAILABLE", "Supplier unavailable"],
  ["OTHER", "Other"],
];

export const DC_STATUS_TONE = {
  DRAFT: "neutral",
  FINALIZED: "info",
  RECEIVING: "warning",
  COMPLETED: "success",
  CANCELLED: "danger",
};

export const RECEIPT_STATUS_LABEL = {
  AWAITING_HANDOVER: "Awaiting department handover",
  PENDING_CONFIRMATION: "Pending confirmation",
  COMPLETED: "Completed",
};

export const RECEIPT_STATUS_TONE = {
  AWAITING_HANDOVER: "warning",
  PENDING_CONFIRMATION: "warning",
  COMPLETED: "success",
};
