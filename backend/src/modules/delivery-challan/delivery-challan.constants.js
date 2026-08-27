export const DC_DOCUMENT_TYPE = "DELIVERY_CHALLAN";

export const DC_STATUS = {
  DRAFT: "DRAFT",
  FINALIZED: "FINALIZED",
  RECEIVING: "RECEIVING",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
};

export const DC_VIEW_PERMISSION = "dc.view";
export const DC_MANAGE_PERMISSION = "dc.manage";

// Statuses a receiver may record against.
export const RECEIVABLE_STATUSES = [DC_STATUS.FINALIZED, DC_STATUS.RECEIVING];
