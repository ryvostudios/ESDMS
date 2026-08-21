// Mirrors backend/src/modules/gate-pass/gate-pass.constants.js — kept in
// sync manually since it's a small, rarely-changing enum. The server
// remains authoritative; this only drives client-side form options and
// labels.
export const GATE_PASS_PURPOSES = [
  "INTER_DEPARTMENT_TRANSFER",
  "REPLACEMENT",
  "WARRANTY",
  "REPAIR_RECTIFICATION",
  "REJECT",
  "SAMPLE",
  "SALES",
  "RETURNABLE",
  "OTHER",
];

export const GATE_PASS_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "VEHICLE_OUTSIDE",
  "COMPLETED",
  "REJECTED",
  "CANCELLED",
];

export const STATUS_TONE = {
  DRAFT: "neutral",
  PENDING_APPROVAL: "warning",
  APPROVED: "info",
  VEHICLE_OUTSIDE: "info",
  COMPLETED: "success",
  REJECTED: "danger",
  CANCELLED: "danger",
};
