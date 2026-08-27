export const MATERIAL_DEMAND_STATUS = {
  DRAFT: "DRAFT",
  PENDING_INITIAL_REVIEW: "PENDING_INITIAL_REVIEW",
  REJECTED: "REJECTED",
  READY_FOR_PRICING: "READY_FOR_PRICING",
  PENDING_FINAL_APPROVAL: "PENDING_FINAL_APPROVAL",
  PRICING_REVISION_REQUIRED: "PRICING_REVISION_REQUIRED",
  READY_FOR_IPO: "READY_FOR_IPO",
  // Set in the same transaction as final approval — the official IPO is
  // generated automatically, so READY_FOR_IPO is an audited boundary rather
  // than a resting state (see material-demand.service.js and
  // modules/ipo/ipo.service.js#generateIpoForApprovedDemand).
  IPO_GENERATED: "IPO_GENERATED",
  IPO_CANCELLED: "IPO_CANCELLED",
  // The DIGITAL Demand -> Procurement -> Receiving workflow is finished.
  // It does NOT mean the material was consumed, and it says nothing about
  // any current stock level — ESDMS has no inventory balance (spec §24).
  COMPLETED: "COMPLETED",
};

export const APPROVAL_STAGE = {
  INITIAL: "INITIAL",
  FINAL: "FINAL",
};

export const APPROVAL_TYPE = {
  MANAGEMENT_REVIEW: "MANAGEMENT_REVIEW",
  FORMAL_APPROVAL: "FORMAL_APPROVAL",
};

export const APPROVAL_PERMISSION = {
  [APPROVAL_TYPE.MANAGEMENT_REVIEW]: "demand.review",
  [APPROVAL_TYPE.FORMAL_APPROVAL]: "demand.approve",
};

export const DECISION = {
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
};

// name -> { from: [allowed current states], to: next state, permission }
// Only `submit` is a plain declarative transition. Recording a review/
// approval decision does not always change status by itself (only
// rejection, or the second of two approvals, does) — that gate-completion
// logic lives in material-demand.service.js#recordApprovalDecision, not
// here. Procurement owns the Checkpoint 4 pricing transition; final
// approval actions and later supply-chain states remain unimplemented.
export const TRANSITIONS = {
  submit: {
    from: [MATERIAL_DEMAND_STATUS.DRAFT],
    to: MATERIAL_DEMAND_STATUS.PENDING_INITIAL_REVIEW,
    permission: "demand.submit",
    action: "SUBMIT",
  },
};
