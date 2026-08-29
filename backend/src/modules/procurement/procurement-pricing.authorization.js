import { ForbiddenError } from "../../shared/errors/app-error.js";
import { assertSupplyChainRecordVisible } from "../../shared/authorization/supply-chain-scope.js";
import {
  ALL_DEMAND_SCOPE_PERMISSION,
  PRICE_VIEW_PERMISSION,
  PRICING_PERMISSION,
} from "./procurement-pricing.constants.js";

export function hasCompanyWideDemandScope(actor) {
  return actor.role === "CEO" || actor.permissions.has(ALL_DEMAND_SCOPE_PERMISSION);
}

// Record scope for pricing, resolved through the SAME three-tier resolver the
// rest of the purchasing chain uses — never a second, weaker rule.
//
// A site-only check was not enough. The detail route also admits
// `procurement.view_prices`, which is deliberately NOT a site-wide scope
// capability: it answers "may this actor see commercial FIELDS on a record
// they can already reach?". Checking only the site let a department user who
// had been granted price visibility read every other department's unit
// prices, line totals and grand total at their site by demand id — the exact
// thing removing it from SITE_WIDE_PERMISSIONS was meant to prevent.
//
// Delegating means an actor holding genuine site-wide reach
// (procurement.site_scope, demand.review, demand.approve) still resolves to
// SITE tier and is unaffected, while an actor holding only an ACTION
// capability — pricing, purchasing or price visibility — correctly resolves
// to OWN tier and is confined to their own department. Scope is granted
// explicitly, never inferred from what an actor may do.
export function assertPricingScope(actor, demand) {
  if (hasCompanyWideDemandScope(actor)) return;

  // Out-of-scope is reported exactly like nonexistent, so the response can
  // never confirm that another department's or site's Demand exists.
  assertSupplyChainRecordVisible(actor, demand);
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

