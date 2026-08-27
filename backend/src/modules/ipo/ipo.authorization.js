import { ForbiddenError } from "../../shared/errors/app-error.js";
import {
  assertSupplyChainRecordVisible,
  resolveSupplyChainScope,
} from "../../shared/authorization/supply-chain-scope.js";
import { IPO_VIEW_PERMISSION, PRICE_PERMISSIONS, PURCHASE_PERMISSION } from "./ipo.constants.js";

export { resolveSupplyChainScope as resolveIpoScope, assertSupplyChainRecordVisible as assertIpoVisible };

export function canSeeCommercialData(actor) {
  return PRICE_PERMISSIONS.some((code) => actor.permissions.has(code));
}

export function assertCanViewIpo(actor) {
  if (!actor.permissions.has(IPO_VIEW_PERMISSION) && !canSeeCommercialData(actor)) {
    throw new ForbiddenError();
  }
}

// The IPO PDF reproduces approved amounts, so it is gated on commercial
// authority in addition to ordinary IPO visibility. A Team Lead holding only
// ipo.view can read the operational IPO but cannot obtain the document.
export function assertCanDownloadIpoPdf(actor) {
  assertCanViewIpo(actor);
  if (!canSeeCommercialData(actor)) {
    throw new ForbiddenError("This document contains commercial information you are not authorized to view.");
  }
}

export function assertCanPurchase(actor) {
  if (!actor.permissions.has(PURCHASE_PERMISSION)) {
    throw new ForbiddenError();
  }
}
