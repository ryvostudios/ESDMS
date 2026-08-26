import { withTransaction } from "../../shared/db/with-transaction.js";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/app-error.js";
import { enqueue } from "../../shared/notifications/outbox.repository.js";
import { resolveEligibleRecipients } from "../../shared/notifications/recipient-resolver.js";
import { MATERIAL_DEMAND_STATUS } from "../material-demand/material-demand.constants.js";
import * as demandRepo from "../material-demand/material-demand.repository.js";
import {
  assertCanPrice,
  assertCanViewPrices,
  assertPricingScope,
  hasCompanyWideDemandScope,
} from "./procurement-pricing.authorization.js";
import {
  ALL_DEMAND_SCOPE_PERMISSION,
  PRICING_PERMISSION,
  PRICING_STATUS,
} from "./procurement-pricing.constants.js";
import * as repo from "./procurement-pricing.repository.js";

function normalizeLine(line) {
  return {
    demandLineId: line.demandLineId || line.demand_line_id,
    estimatedUnitPrice: String(line.estimatedUnitPrice || line.estimated_unit_price),
    procurementNote: (line.procurementNote ?? line.procurement_note ?? null) || null,
  };
}

function canonicalPrice(value) {
  const [whole, fraction = ""] = String(value).split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

function pricingLinesEqual(existing, requested) {
  if (existing.length !== requested.length) return false;

  const existingById = new Map(existing.map((line) => [line.demand_line_id, normalizeLine(line)]));
  return requested.every((line) => {
    const old = existingById.get(line.demandLineId);
    if (!old) return false;
    return (
      canonicalPrice(old.estimatedUnitPrice) === canonicalPrice(line.estimatedUnitPrice) &&
      old.procurementNote === (line.procurementNote || null)
    );
  });
}

function assertCurrentRevision(demand, revision) {
  if (demand.revision !== revision) {
    throw new ConflictError("Demand revision changed. Reload pricing before continuing.");
  }
}

function assertLineOwnership(demandLines, requestedLines) {
  const validIds = new Set(demandLines.map((line) => line.id));
  if (requestedLines.some((line) => !validIds.has(line.demandLineId))) {
    throw new ValidationError("One or more pricing lines do not belong to this Demand revision.");
  }
}

export async function listPricingQueue(actor, query) {
  assertCanPrice(actor);
  if (!hasCompanyWideDemandScope(actor) && !actor.siteId) {
    return { rows: [], total: 0 };
  }
  return repo.listReadyForPricing({
    siteId: hasCompanyWideDemandScope(actor) ? null : actor.siteId,
    ...query,
  });
}

export async function getPricing(actor, demandId) {
  assertCanViewPrices(actor);
  const demand = await repo.findDemandById(demandId);
  if (!demand) throw new NotFoundError("Demand not found.");
  assertPricingScope(actor, demand);

  const detail = await repo.getPricingDetail(demandId, demand.revision);
  const canEdit = actor.permissions.has(PRICING_PERMISSION);

  if (!canEdit && detail.pricing?.status !== PRICING_STATUS.SUBMITTED) {
    throw new NotFoundError("Submitted pricing not found.");
  }

  return { ...detail, canEdit: canEdit && detail.pricing?.status !== PRICING_STATUS.SUBMITTED };
}

export async function savePricing(actor, demandId, input) {
  assertCanPrice(actor);

  await withTransaction(async (client) => {
    const demand = await demandRepo.lockById(client, demandId);
    if (!demand) throw new NotFoundError("Demand not found.");
    assertPricingScope(actor, demand);
    assertCurrentRevision(demand, input.revision);

    if (demand.status !== MATERIAL_DEMAND_STATUS.READY_FOR_PRICING) {
      throw new ConflictError(`Cannot edit pricing for a Demand currently in ${demand.status} state.`);
    }

    const demandLines = await repo.findDemandLines(client, demandId);
    assertLineOwnership(demandLines, input.lines);

    let pricing = await repo.findPricing(client, demandId, input.revision, { forUpdate: true });
    if (pricing?.status === PRICING_STATUS.SUBMITTED) {
      throw new ConflictError("Submitted pricing is immutable.");
    }

    if (!pricing) {
      pricing = await repo.createPricing(client, {
        demandId,
        revision: input.revision,
        currency: input.currency,
        actorId: actor.id,
      });
      await repo.replacePricingLines(client, pricing.id, demandId, input.lines);
      await demandRepo.insertAuditLog(client, {
        demandId,
        actorUserId: actor.id,
        action: "PRICING_DRAFT_CREATED",
        previousStatus: demand.status,
        newStatus: demand.status,
      });
      return;
    }

    if (pricing.currency !== input.currency) {
      throw new ValidationError("Pricing currency cannot be changed.");
    }

    const existingLines = await repo.findPricingLines(client, pricing.id);
    if (pricingLinesEqual(existingLines, input.lines)) return;

    await repo.replacePricingLines(client, pricing.id, demandId, input.lines);
    await demandRepo.insertAuditLog(client, {
      demandId,
      actorUserId: actor.id,
      action: "PRICING_DRAFT_SAVED",
      previousStatus: demand.status,
      newStatus: demand.status,
    });
  });

  return getPricing(actor, demandId);
}

function assertCompletePricing(demandLines, pricingLines) {
  if (demandLines.length === 0 || demandLines.length !== pricingLines.length) {
    throw new ValidationError("Every active Demand line must have an estimated unit price before submission.");
  }

  const requiredIds = new Set(demandLines.map((line) => line.id));
  if (pricingLines.some((line) => !requiredIds.has(line.demand_line_id))) {
    throw new ValidationError("Pricing contains a line that does not belong to this Demand revision.");
  }
}

export async function submitPricing(actor, demandId, input) {
  assertCanPrice(actor);

  await withTransaction(async (client) => {
    const demand = await demandRepo.lockById(client, demandId);
    if (!demand) throw new NotFoundError("Demand not found.");
    assertPricingScope(actor, demand);
    assertCurrentRevision(demand, input.revision);

    const pricing = await repo.findPricing(client, demandId, input.revision, { forUpdate: true });

    // A replay after a committed submission is a successful no-op. This
    // gives retrying clients an idempotent response while preserving one
    // transition, audit pair, and recipient-specific outbox row.
    if (
      demand.status === MATERIAL_DEMAND_STATUS.PENDING_FINAL_APPROVAL &&
      pricing?.status === PRICING_STATUS.SUBMITTED
    ) {
      return;
    }

    if (demand.status !== MATERIAL_DEMAND_STATUS.READY_FOR_PRICING) {
      throw new ConflictError(`Cannot submit pricing for a Demand currently in ${demand.status} state.`);
    }
    if (!pricing) throw new ValidationError("Save pricing before submission.");
    if (pricing.status !== PRICING_STATUS.DRAFT) throw new ConflictError("Pricing has already been submitted.");

    const [demandLines, pricingLines] = await Promise.all([
      repo.findDemandLines(client, demandId),
      repo.findPricingLines(client, pricing.id),
    ]);
    assertCompletePricing(demandLines, pricingLines);

    await repo.markSubmitted(client, pricing.id, actor.id);
    await demandRepo.insertAuditLog(client, {
      demandId,
      actorUserId: actor.id,
      action: "PRICING_SUBMITTED",
      previousStatus: demand.status,
      newStatus: demand.status,
    });

    await demandRepo.updateStatus(client, demandId, MATERIAL_DEMAND_STATUS.PENDING_FINAL_APPROVAL);
    await demandRepo.insertAuditLog(client, {
      demandId,
      actorUserId: actor.id,
      action: "PENDING_FINAL_APPROVAL",
      previousStatus: demand.status,
      newStatus: MATERIAL_DEMAND_STATUS.PENDING_FINAL_APPROVAL,
    });

    const [reviewers, approvers] = await Promise.all([
      resolveEligibleRecipients({
        capabilityCode: "demand.review",
        allScopePermissionCode: ALL_DEMAND_SCOPE_PERMISSION,
        siteId: demand.site_id,
      }),
      resolveEligibleRecipients({
        capabilityCode: "demand.approve",
        allScopePermissionCode: ALL_DEMAND_SCOPE_PERMISSION,
        siteId: demand.site_id,
      }),
    ]);
    const reviewerSet = new Set(reviewers);
    const approverSet = new Set(approvers);
    const recipientIds = new Set([...reviewers, ...approvers]);

    if (recipientIds.size > 0) {
      await enqueue(
        client,
        [...recipientIds].map((userId) => {
          const responsibility = reviewerSet.has(userId) && approverSet.has(userId)
            ? "final review and approval"
            : approverSet.has(userId)
              ? "final approval"
              : "final review";
          return {
            channel: "IN_APP",
            eventType: "DEMAND_PRICING_SUBMITTED",
            entityType: "MATERIAL_DEMAND",
            entityId: demandId,
            recipientUserId: userId,
            recipientSiteId: demand.site_id,
            idempotencyKey: `demand:${demandId}:rev:${demand.revision}:final-review:${userId}`,
            payload: {
              demandNumber: demand.demand_number,
              departmentId: demand.department_id,
              message: `Pricing for ${demand.department_name} Demand ${demand.demand_number} is ready for ${responsibility}.`,
              deepLink: `/demands/${demandId}`,
            },
          };
        }),
      );
    }
  });

  return getPricing(actor, demandId);
}
