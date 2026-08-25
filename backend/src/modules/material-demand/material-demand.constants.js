export const MATERIAL_DEMAND_STATUS = {
  DRAFT: "DRAFT",
  PENDING_INITIAL_REVIEW: "PENDING_INITIAL_REVIEW",
  REJECTED: "REJECTED",
  READY_FOR_PRICING: "READY_FOR_PRICING",
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
// here. Checkpoints 4+ (pricing, IPO, purchasing, DC, receiving) remain
// unimplemented — see docs/PROCUREMENT_RECEIVING_SPEC.md §30.
export const TRANSITIONS = {
  submit: {
    from: [MATERIAL_DEMAND_STATUS.DRAFT],
    to: MATERIAL_DEMAND_STATUS.PENDING_INITIAL_REVIEW,
    permission: "demand.submit",
    action: "SUBMIT",
  },
};
