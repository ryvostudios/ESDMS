export const IPO_DOCUMENT_TYPE = "IPO";

export const IPO_STATUS = {
  GENERATED: "GENERATED",
  ACKNOWLEDGED: "ACKNOWLEDGED",
  PURCHASING: "PURCHASING",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
};

export const PURCHASE_STATUS = {
  NOT_PURCHASED: "NOT_PURCHASED",
  PARTIALLY_PURCHASED: "PARTIALLY_PURCHASED",
  PURCHASED: "PURCHASED",
};

export const IPO_VIEW_PERMISSION = "ipo.view";
export const IPO_CANCEL_PERMISSION = "ipo.cancel";
export const PURCHASE_PERMISSION = "procurement.purchase";
export const PRICE_VIEW_PERMISSION = "procurement.view_prices";

// A purchasing document is commercial. Operational visibility (ipo.view)
// shows quantities, items and workflow state; it never implies price
// visibility, and the IPO PDF — which carries approved amounts — additionally
// requires one of these. This is what stops the PDF endpoint from becoming a
// price-leak bypass for an operational viewer (spec §10, §28).
export const PRICE_PERMISSIONS = [PRICE_VIEW_PERMISSION, PURCHASE_PERMISSION, "procurement.pricing"];

export const CANCELLATION_CATEGORIES = [
  "NO_LONGER_REQUIRED",
  "BUDGET_WITHDRAWN",
  "DUPLICATE",
  "SUPPLIER_UNAVAILABLE",
  "OTHER",
];

export const ACTIVE_IPO_STATUSES = [IPO_STATUS.GENERATED, IPO_STATUS.ACKNOWLEDGED, IPO_STATUS.PURCHASING];
