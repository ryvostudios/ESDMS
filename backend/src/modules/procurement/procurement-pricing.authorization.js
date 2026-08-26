import { ForbiddenError, NotFoundError } from "../../shared/errors/app-error.js";
import {
  ALL_DEMAND_SCOPE_PERMISSION,
  PRICE_VIEW_PERMISSION,
  PRICING_PERMISSION,
} from "./procurement-pricing.constants.js";

export function hasCompanyWideDemandScope(actor) {
  return actor.role === "CEO" || actor.permissions.has(ALL_DEMAND_SCOPE_PERMISSION);
}

export function assertPricingScope(actor, demand) {
  if (hasCompanyWideDemandScope(actor)) return;

  if (!actor.siteId || actor.siteId !== demand.site_id) {
    // Preserve the established cross-site data-minimization behavior: an
    // out-of-scope Demand is indistinguishable from a nonexistent one.
    throw new NotFoundError("Demand not found.");
  }
}

export function assertCanPrice(actor) {
  if (!actor.permissions.has(PRICING_PERMISSION)) {
    throw new ForbiddenError();
  }
}

export function assertCanViewPrices(actor) {
  if (!actor.permissions.has(PRICING_PERMISSION) && !actor.permissions.has(PRICE_VIEW_PERMISSION)) {
    throw new ForbiddenError();
  }
}

