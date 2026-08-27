import { createHash } from "node:crypto";
import { withTransaction } from "../../shared/db/with-transaction.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../shared/errors/app-error.js";
import { PRICE_VIEW_PERMISSION } from "../procurement/procurement-pricing.constants.js";
import * as pricingRepo from "../procurement/procurement-pricing.repository.js";
import { assertReviewActionAllowed } from "./material-demand.authorization.js";
import { MATERIAL_DEMAND_STATUS } from "./material-demand.constants.js";
import * as repo from "./material-demand.repository.js";
import * as dispositionRepo from "./material-demand.disposition.repository.js";

// A stable identity for one exact purchasing set: which Demand lines are in,
// and which are out. Every FINAL approval records the fingerprint of the set
// it was actually deciding on, and the gate completes only when BOTH
// responsibilities have approved the SAME, still-current set.
//
// That is what makes a real business event safe: a Site Manager records the
// final review, the CEO then rules a line out of budget, and the earlier
// review simply no longer satisfies the gate — it is neither rewritten nor
// deleted, and the Site Manager decides again on the new set as a new
// immutable row.
//
// Deliberately keyed on line + disposition only. The exclusion CATEGORY and
// free-text explanation are metadata about a decision, not the purchasing set
// itself, so correcting a category does not invalidate anyone's approval.
export function fingerprintOf(lines) {
  const canonical = lines
    .map((line) => `${line.demand_line_id}:${line.disposition}`)
    .sort()
    .join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

export async function computeDispositionFingerprint(client, demandId, pricingId) {
  return fingerprintOf(await dispositionRepo.findPurchasableLines(client, demandId, pricingId));
}

export const DISPOSITION = {
  APPROVED_FOR_PURCHASE: "APPROVED_FOR_PURCHASE",
  EXCLUDED: "EXCLUDED",
};

export const EXCLUSION_CATEGORIES = [
  "OUT_OF_BUDGET",
  "NOT_REQUIRED_NOW",
  "ALREADY_AVAILABLE",
  "DUPLICATE",
  "OTHER",
];

// Setting a disposition is a management act on confidential commercial
// content (the decision is literally "this line's price is out of budget"),
// so it requires the same capability intersection the final gate itself
// requires: a review/approval responsibility AND price visibility.
function assertCanDispose(actor) {
  const hasResponsibility = actor.permissions.has("demand.review") || actor.permissions.has("demand.approve");
  if (!hasResponsibility || !actor.permissions.has(PRICE_VIEW_PERMISSION)) {
    throw new ForbiddenError();
  }
}

// A line-level exclusion is NOT a deletion: the Demand line, its requested
// quantity, its Pricing version and its estimated price all survive intact,
// and the rest of the Demand proceeds normally. Only the excluded lines are
// kept out of the IPO.
export async function setLineDispositions(actor, demandId, { pricingId, lines }) {
  assertCanDispose(actor);

  await withTransaction(async (client) => {
    // Same lock order as every other writer on this chain: Demand, then the
    // Pricing header.
    const demand = await repo.lockById(client, demandId);
    if (!demand) throw new NotFoundError("Demand not found.");
    assertReviewActionAllowed(actor, demand);

    if (demand.status !== MATERIAL_DEMAND_STATUS.PENDING_FINAL_APPROVAL) {
      throw new ConflictError(
        `Line purchasing decisions can only be recorded while a Demand is pending final approval, not in ${demand.status} state.`,
      );
    }

    const pricing = await pricingRepo.findPricing(client, demandId, demand.revision, { forUpdate: true });
    if (!pricing || pricing.id !== pricingId || pricing.status !== "SUBMITTED") {
      throw new ConflictError("The submitted Pricing version changed. Reload before deciding.");
    }

    const purchasable = await dispositionRepo.findPurchasableLines(client, demandId, pricing.id);
    const byLineId = new Map(purchasable.map((line) => [line.demand_line_id, line]));

    for (const requested of lines) {
      const line = byLineId.get(requested.demandLineId);
      if (!line) {
        throw new ValidationError("One or more lines do not belong to this Demand's submitted pricing.");
      }

      await dispositionRepo.upsertDisposition(client, {
        demandId,
        revision: demand.revision,
        pricingId: pricing.id,
        demandLineId: requested.demandLineId,
        disposition: requested.disposition,
        exclusionCategory: requested.disposition === DISPOSITION.EXCLUDED ? requested.exclusionCategory : null,
        reason: requested.disposition === DISPOSITION.EXCLUDED ? requested.reason : null,
        requestedQuantity: line.requested_quantity,
        estimatedUnitPrice: line.estimated_unit_price,
        actorUserId: actor.id,
      });

      byLineId.set(requested.demandLineId, { ...line, disposition: requested.disposition });
    }

    // Excluding everything is not a purchasing decision, it is a rejection —
    // and rejection already has its own audited path that returns the Demand
    // to Procurement for repricing.
    const stillPurchasable = [...byLineId.values()].some(
      (line) => line.disposition === DISPOSITION.APPROVED_FOR_PURCHASE,
    );
    if (!stillPurchasable) {
      throw new ValidationError(
        "At least one line must remain approved for purchase. Reject the pricing instead of excluding every line.",
      );
    }

    await repo.insertAuditLog(client, {
      demandId,
      actorUserId: actor.id,
      action: "LINE_DISPOSITION_SET",
      previousStatus: demand.status,
      newStatus: demand.status,
      // Categories and counts only — never the prices the decision was about
      // (the operational audit stream has a wider audience than price view).
      metadata: {
        pricingId: pricing.id,
        pricingVersion: pricing.version,
        excludedLineCount: lines.filter((line) => line.disposition === DISPOSITION.EXCLUDED).length,
        categories: [
          ...new Set(lines.filter((line) => line.exclusionCategory).map((line) => line.exclusionCategory)),
        ],
      },
    });
  });
}

// Redacts the free-text explanation for an actor without price authority,
// exactly as FINAL approval reasons already are. The CATEGORY stays visible:
// the department that raised the Demand legitimately needs to know a line was
// excluded and broadly why, so it can decide whether to carry it forward.
export function redactDispositions(dispositions, actor) {
  const canSeeFinancialContext =
    actor.permissions.has(PRICE_VIEW_PERMISSION) || actor.permissions.has("procurement.pricing");

  return dispositions.map((disposition) => {
    const base = canSeeFinancialContext
      ? disposition
      : { ...disposition, reason: null, estimated_unit_price_snapshot: undefined };
    return base;
  });
}

export const findDispositionsByDemandId = dispositionRepo.findDispositionsByDemandId;
