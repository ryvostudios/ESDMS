export const GATE_PASS_STATUS = {
  DRAFT: "DRAFT",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  APPROVED: "APPROVED",
  VEHICLE_OUTSIDE: "VEHICLE_OUTSIDE",
  COMPLETED: "COMPLETED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
};

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

// name -> { from: [allowed current states], to: next state, permission }
export const TRANSITIONS = {
  submit: {
    from: [GATE_PASS_STATUS.DRAFT],
    to: GATE_PASS_STATUS.PENDING_APPROVAL,
    permission: "gate_pass.submit",
    action: "SUBMIT",
  },
  approve: {
    from: [GATE_PASS_STATUS.DRAFT, GATE_PASS_STATUS.PENDING_APPROVAL],
    to: GATE_PASS_STATUS.APPROVED,
    permission: "gate_pass.approve",
    action: "APPROVE",
  },
  reject: {
    from: [GATE_PASS_STATUS.DRAFT, GATE_PASS_STATUS.PENDING_APPROVAL],
    to: GATE_PASS_STATUS.REJECTED,
    permission: "gate_pass.reject",
    action: "REJECT",
  },
  cancel: {
    from: [GATE_PASS_STATUS.DRAFT, GATE_PASS_STATUS.PENDING_APPROVAL, GATE_PASS_STATUS.APPROVED],
    to: GATE_PASS_STATUS.CANCELLED,
    permission: "gate_pass.cancel",
    action: "CANCEL",
  },
};

export const MAX_EVIDENCE_PHOTO_BYTES = 5 * 1024 * 1024;
export const ALLOWED_PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
