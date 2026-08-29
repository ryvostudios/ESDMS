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
// Per request. A Guard photographing several angles is normal; an unbounded
// count is not — this caps one request's storage and PDF cost without
// capping how many photos a Gate Pass can accumulate over its life.
export const MAX_EVIDENCE_PHOTOS_PER_REQUEST = 10;
// Total per Gate Pass, across every request, so a completion PDF stays
// practical to render and to deliver over WhatsApp.
export const MAX_EVIDENCE_PHOTOS_PER_GATE_PASS = 40;

export const EVIDENCE_KIND = {
  OUTBOUND: "OUTBOUND",
  INBOUND: "INBOUND",
  // Evidence of something that was never on the approved pass. Recorded as
  // gate evidence in its own right; it is never added to the approved item
  // list and never reported as an approved outbound item.
  INBOUND_ADDITIONAL: "INBOUND_ADDITIONAL",
};

export const EVIDENCE_FILE_TYPE = {
  [EVIDENCE_KIND.OUTBOUND]: "DEPARTURE_PHOTO",
  [EVIDENCE_KIND.INBOUND]: "RETURN_PHOTO",
  [EVIDENCE_KIND.INBOUND_ADDITIONAL]: "RETURN_ADDITIONAL_PHOTO",
};
export const ALLOWED_PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
