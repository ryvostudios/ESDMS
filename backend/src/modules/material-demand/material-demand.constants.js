export const MATERIAL_DEMAND_STATUS = {
  DRAFT: "DRAFT",
  PENDING_INITIAL_REVIEW: "PENDING_INITIAL_REVIEW",
};

// name -> { from: [allowed current states], to: next state, permission }
// Only `submit` exists in this checkpoint — approve/reject/reopen are
// Checkpoint 3+ (see docs/PROCUREMENT_RECEIVING_SPEC.md §30).
export const TRANSITIONS = {
  submit: {
    from: [MATERIAL_DEMAND_STATUS.DRAFT],
    to: MATERIAL_DEMAND_STATUS.PENDING_INITIAL_REVIEW,
    permission: "demand.submit",
    action: "SUBMIT",
  },
};
