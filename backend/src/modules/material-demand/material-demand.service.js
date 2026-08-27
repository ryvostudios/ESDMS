import pool from "../../config/database.js";
import { withTransaction } from "../../shared/db/with-transaction.js";
import { enqueue } from "../../shared/notifications/outbox.repository.js";
import { resolveEligibleRecipients } from "../../shared/notifications/recipient-resolver.js";
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from "../../shared/errors/app-error.js";
import { findDepartmentById } from "../departments/departments.repository.js";
import {
  resolveDemandDepartmentId,
  resolveDemandListScope,
  assertDemandManageable,
  assertDemandViewable,
  assertReviewActionAllowed,
} from "./material-demand.authorization.js";
import {
  TRANSITIONS,
  MATERIAL_DEMAND_STATUS,
  APPROVAL_STAGE,
  APPROVAL_TYPE,
  APPROVAL_PERMISSION,
  DECISION,
} from "./material-demand.constants.js";
import { PRICE_VIEW_PERMISSION } from "../procurement/procurement-pricing.constants.js";
import { generateIpoForApprovedDemand } from "../ipo/ipo.service.js";
import * as pricingRepo from "../procurement/procurement-pricing.repository.js";
import { documentFilename } from "../../shared/documents/document-number.js";
import {
  allocateCarryForwardOnSubmit,
  assertCarryForwardLinesValid,
  findAllocationsForDemand,
  releaseCarryForward,
} from "./carry-forward.service.js";
import { generateDemandListPdf } from "./material-demand.pdf.js";
import {
  computeDispositionFingerprint,
  findDispositionsByDemandId,
  redactDispositions,
} from "./material-demand.disposition.service.js";
import * as repo from "./material-demand.repository.js";

const ALL_DEPARTMENTS_PERMISSION = "demand.all_departments";
const OTHER_APPROVAL_TYPE = {
  [APPROVAL_TYPE.MANAGEMENT_REVIEW]: APPROVAL_TYPE.FORMAL_APPROVAL,
  [APPROVAL_TYPE.FORMAL_APPROVAL]: APPROVAL_TYPE.MANAGEMENT_REVIEW,
};

async function loadUsableDepartment(departmentId) {
  const department = await findDepartmentById(departmentId);
  if (!department || !department.is_active) {
    throw new ValidationError("Invalid department.");
  }
  return department;
}

// Resolves every requested line's catalog entry within `departmentId` in
// one query, rejecting the whole request if any line references something
// nonexistent, archived, or belonging to a different department — those
// three cases are deliberately indistinguishable to the caller (see
// material-demand.repository.js#findCatalogEntriesForLines).
async function resolveLineEntries(departmentId, lines) {
  if (lines.length === 0) {
    return new Map();
  }

  const catalogEntryIds = lines.map((line) => line.catalogEntryId);
  const entries = await repo.findCatalogEntriesForLines(departmentId, catalogEntryIds);
  const entriesByCatalogEntryId = new Map(entries.map((entry) => [entry.catalog_entry_id, entry]));

  for (const id of catalogEntryIds) {
    if (!entriesByCatalogEntryId.has(id)) {
      throw new ValidationError("One or more selected materials are invalid for this department's catalog.");
    }
  }

  return entriesByCatalogEntryId;
}

export async function createDemand(actor, input) {
  const departmentId = resolveDemandDepartmentId(actor, input.departmentId);
  const department = await loadUsableDepartment(departmentId);

  const entriesByCatalogEntryId = await resolveLineEntries(departmentId, input.lines);
  await assertCarryForwardLinesValid(departmentId, input.lines);

  return withTransaction(async (client) => {
    const demandNumber = await repo.nextDemandNumber(client);
    const id = await repo.insertDraft(client, {
      demandNumber,
      siteId: department.site_id,
      departmentId,
      actorId: actor.id,
      note: input.note,
    });

    await repo.insertLines(client, id, departmentId, input.lines, entriesByCatalogEntryId);

    await repo.insertAuditLog(client, {
      demandId: id,
      actorUserId: actor.id,
      action: "CREATE",
      newStatus: MATERIAL_DEMAND_STATUS.DRAFT,
    });

    return id;
  });
}

export async function updateDraft(actor, id, input) {
  return withTransaction(async (client) => {
    const demand = await repo.lockById(client, id);

    if (!demand) {
      throw new NotFoundError("Demand not found.");
    }

    assertDemandManageable(actor, demand);

    if (demand.status !== MATERIAL_DEMAND_STATUS.DRAFT) {
      throw new ConflictError("Only a Demand in DRAFT can be edited.");
    }

    if (input.note !== undefined) {
      await repo.updateNote(client, id, input.note);
    }

    if (input.lines) {
      const entriesByCatalogEntryId = await resolveLineEntries(demand.department_id, input.lines);
      await assertCarryForwardLinesValid(demand.department_id, input.lines);
      await repo.replaceLines(client, id, demand.department_id, input.lines, entriesByCatalogEntryId);
    }

    await repo.insertAuditLog(client, {
      demandId: id,
      actorUserId: actor.id,
      action: "EDIT_DRAFT",
      previousStatus: MATERIAL_DEMAND_STATUS.DRAFT,
      newStatus: MATERIAL_DEMAND_STATUS.DRAFT,
    });
  });
}

export async function getDemandDetail(actor, id) {
  const demand = await repo.findById(id);

  if (!demand) {
    throw new NotFoundError("Demand not found.");
  }

  assertDemandViewable(actor, demand);

  const [lines, auditLog, storedApprovals, storedDispositions, ipo] = await Promise.all([
    repo.findLinesByDemandId(id),
    repo.findAuditLogByDemandId(id),
    repo.findApprovalsByDemandId(id),
    findDispositionsByDemandId(id),
    repo.findIpoSummaryByDemandId(id),
  ]);
  const carryForwardAllocations = await findAllocationsForDemand(pool, id);

  const canSeeFinancialReasons =
    actor.permissions.has(PRICE_VIEW_PERMISSION) || actor.permissions.has("procurement.pricing");
  const approvals = storedApprovals.map((approval) =>
    approval.approval_stage === APPROVAL_STAGE.FINAL && !canSeeFinancialReasons
      ? { ...approval, reason: null }
      : approval,
  );

  // The department that raised the Demand must be able to see that a line
  // was excluded and under which category, so it can decide whether to carry
  // it forward — but the free-text financial explanation stays behind the
  // price gate, exactly like a FINAL rejection reason.
  const dispositions = redactDispositions(storedDispositions, actor);

  return { demand, lines, auditLog, approvals, dispositions, ipo, carryForwardAllocations };
}

export async function listDemands(actor, filters) {
  const scope = resolveDemandListScope(actor, filters.departmentId);

  if (scope.tier === "OWN" && !scope.departmentId) {
    // An ordinary actor with no department assigned has nothing to show —
    // must short-circuit here rather than pass departmentId: null through,
    // where the repository would treat it as "unrestricted".
    return { rows: [], total: 0 };
  }

  return repo.listForScope(scope, filters);
}

export async function submitDemand(actor, id) {
  const definition = TRANSITIONS.submit;

  if (!actor.permissions.has(definition.permission)) {
    throw new ForbiddenError();
  }

  await withTransaction(async (client) => {
    const demand = await repo.lockById(client, id);

    if (!demand) {
      throw new NotFoundError("Demand not found.");
    }

    assertDemandManageable(actor, demand);

    if (!definition.from.includes(demand.status)) {
      throw new ConflictError(`Cannot submit a Demand currently in ${demand.status} state.`);
    }

    // Quantity > 0, valid catalog relationships, and no duplicate lines are
    // all enforced structurally at write time (Zod + DB CHECK/FK/UNIQUE
    // constraints in the migration) — a persisted line cannot violate any
    // of them, so submit only needs to check line count, the one condition
    // that can genuinely change after lines were validly written (every
    // line removed since).
    const lines = await repo.findLinesByDemandId(id);
    if (lines.length === 0) {
      throw new ValidationError("A Demand must have at least one line before it can be submitted.");
    }

    // Submitting is the moment the department commits to the request, so it
    // is also the moment any carried-forward quantity is actually claimed
    // against its source. Runs under the Demand row lock already held, and
    // the allocation guard locks the source itself, so two Demands submitting
    // against the same remaining quantity serialize instead of both winning.
    await allocateCarryForwardOnSubmit(client, demand, actor.id);

    await repo.markSubmitted(client, id, definition.to);

    await repo.insertAuditLog(client, {
      demandId: id,
      actorUserId: actor.id,
      action: definition.action,
      previousStatus: demand.status,
      newStatus: definition.to,
    });

    // Capability-driven, per-recipient routing (Checkpoint 3) — replaces
    // Checkpoint 2's temporary role+site enqueue. resolveEligibleRecipients
    // reuses the single authoritative effective-permissions computation,
    // so a user's actual GRANT/DENY overrides and active state are always
    // respected, not just their role's baseline. Deduped across both
    // capabilities so a user holding both (e.g. CEO) gets one notification,
    // not two — recipient-specific idempotency keys prevent a replayed
    // Submit from ever duplicating one.
    const [reviewers, approvers] = await Promise.all([
      resolveEligibleRecipients({
        capabilityCode: APPROVAL_PERMISSION[APPROVAL_TYPE.MANAGEMENT_REVIEW],
        allScopePermissionCode: ALL_DEPARTMENTS_PERMISSION,
        siteId: demand.site_id,
      }),
      resolveEligibleRecipients({
        capabilityCode: APPROVAL_PERMISSION[APPROVAL_TYPE.FORMAL_APPROVAL],
        allScopePermissionCode: ALL_DEPARTMENTS_PERMISSION,
        siteId: demand.site_id,
      }),
    ]);
    const recipientUserIds = new Set([...reviewers, ...approvers]);

    const payload = {
      demandNumber: demand.demand_number,
      departmentId: demand.department_id,
      submittedAt: new Date().toISOString(),
    };

    if (recipientUserIds.size > 0) {
      await enqueue(
        client,
        [...recipientUserIds].map((userId) => ({
          channel: "IN_APP",
          eventType: "DEMAND_SUBMITTED",
          entityType: "MATERIAL_DEMAND",
          entityId: id,
          recipientUserId: userId,
          recipientSiteId: demand.site_id,
          idempotencyKey: `demand:${id}:rev:${demand.revision}:initial-review:${userId}`,
          payload,
        })),
      );
    }
  });
}

async function recordApprovalDecision(actor, id, approvalType, { decision, reason }) {
  const permission = APPROVAL_PERMISSION[approvalType];

  if (!actor.permissions.has(permission)) {
    throw new ForbiddenError();
  }

  await withTransaction(async (client) => {
    const demand = await repo.lockById(client, id);

    if (!demand) {
      throw new NotFoundError("Demand not found.");
    }

    assertReviewActionAllowed(actor, demand);

    if (demand.status !== MATERIAL_DEMAND_STATUS.PENDING_INITIAL_REVIEW) {
      throw new ConflictError(`Cannot record a decision for a Demand currently in ${demand.status} state.`);
    }

    // Slot-already-filled guard — first writer wins, backed by the DB's
    // own unique(demand_id, revision, approval_type) constraint. A
    // concurrent second writer for the SAME slot blocks here (waiting on
    // the row lock above), then finds this row already present.
    const existingSame = await repo.findApproval(client, id, demand.revision, approvalType);
    if (existingSame) {
      throw new ConflictError(
        `${approvalType === APPROVAL_TYPE.MANAGEMENT_REVIEW ? "Management Review" : "Formal Approval"} has already been decided for this Demand.`,
      );
    }

    // A single ordinary user may not fill both required slots on the same
    // Demand — Management Review and Formal Approval are meant to be two
    // distinct workflow responsibilities. CEO is a deliberate, documented
    // exception (existing exceptional platform authority), not an
    // accident of also holding both capabilities — see docs/DECISIONS.md.
    if (actor.role !== "CEO") {
      const otherType = OTHER_APPROVAL_TYPE[approvalType];
      const existingOther = await repo.findApproval(client, id, demand.revision, otherType);
      if (existingOther && existingOther.actor_user_id === actor.id) {
        throw new ConflictError(
          "The same user cannot record both the Management Review and Formal Approval decisions on one Demand.",
        );
      }
    }

    await repo.insertApproval(client, {
      demandId: id,
      revision: demand.revision,
      approvalType,
      decision,
      actorUserId: actor.id,
      reason,
    });

    await repo.insertAuditLog(client, {
      demandId: id,
      actorUserId: actor.id,
      action: `${approvalType}_${decision}`,
      previousStatus: demand.status,
      newStatus: decision === DECISION.REJECTED ? MATERIAL_DEMAND_STATUS.REJECTED : demand.status,
      metadata: reason ? { reason } : undefined,
    });

    if (decision === DECISION.REJECTED) {
      await repo.updateStatus(client, id, MATERIAL_DEMAND_STATUS.REJECTED);
      // The request died, so any quantity it had claimed returns to the pool
      // for the department's next Demand. The claim rows are kept, marked
      // RELEASED, so who claimed what and when stays readable.
      await releaseCarryForward(client, id);
      return;
    }

    const otherType = OTHER_APPROVAL_TYPE[approvalType];
    const otherApproval = await repo.findApproval(client, id, demand.revision, otherType);
    const gateComplete = Boolean(otherApproval) && otherApproval.decision === DECISION.APPROVED;

    if (!gateComplete) {
      return;
    }

    await repo.updateStatus(client, id, MATERIAL_DEMAND_STATUS.READY_FOR_PRICING);

    await repo.insertAuditLog(client, {
      demandId: id,
      actorUserId: actor.id,
      action: "READY_FOR_PRICING",
      previousStatus: MATERIAL_DEMAND_STATUS.PENDING_INITIAL_REVIEW,
      newStatus: MATERIAL_DEMAND_STATUS.READY_FOR_PRICING,
    });

    const procurementRecipients = await resolveEligibleRecipients({
      capabilityCode: "procurement.pricing",
      siteId: demand.site_id,
    });

    if (procurementRecipients.length > 0) {
      const payload = {
        demandNumber: demand.demand_number,
        departmentId: demand.department_id,
        readyAt: new Date().toISOString(),
      };

      await enqueue(
        client,
        procurementRecipients.map((userId) => ({
          channel: "IN_APP",
          eventType: "DEMAND_READY_FOR_PRICING",
          entityType: "MATERIAL_DEMAND",
          entityId: id,
          recipientUserId: userId,
          recipientSiteId: demand.site_id,
          idempotencyKey: `demand:${id}:rev:${demand.revision}:ready-for-pricing:${userId}`,
          payload,
        })),
      );
    }
  });
}

export const recordManagementReview = (actor, id, decision) =>
  recordApprovalDecision(actor, id, APPROVAL_TYPE.MANAGEMENT_REVIEW, decision);

export const recordFormalApproval = (actor, id, decision) =>
  recordApprovalDecision(actor, id, APPROVAL_TYPE.FORMAL_APPROVAL, decision);

function finalAuditAction(approvalType, decision) {
  return approvalType === APPROVAL_TYPE.MANAGEMENT_REVIEW
    ? `FINAL_MANAGEMENT_${decision}`
    : `FINAL_FORMAL_${decision}`;
}

async function recordFinalApprovalDecision(actor, id, approvalType, { pricingId, decision, reason }) {
  const permission = APPROVAL_PERMISSION[approvalType];
  if (!actor.permissions.has(permission) || !actor.permissions.has(PRICE_VIEW_PERMISSION)) {
    throw new ForbiddenError();
  }

  await withTransaction(async (client) => {
    // Consistent lock order shared with Procurement save/submit/repricing:
    // Demand first, then the current Pricing header.
    const demand = await repo.lockById(client, id);
    if (!demand) throw new NotFoundError("Demand not found.");
    assertReviewActionAllowed(actor, demand);

    if (demand.status !== MATERIAL_DEMAND_STATUS.PENDING_FINAL_APPROVAL) {
      throw new ConflictError(`Cannot record a final decision for a Demand currently in ${demand.status} state.`);
    }

    const pricing = await pricingRepo.findPricing(client, id, demand.revision, { forUpdate: true });
    if (!pricing || pricing.id !== pricingId || pricing.status !== "SUBMITTED") {
      throw new ConflictError("The submitted Pricing version changed. Reload before deciding.");
    }

    // The exact purchasing set this decision is about. Recorded on the
    // approval row, so a later out-of-budget exclusion cannot leave this
    // decision authoritative over a set its decider never saw.
    const dispositionFingerprint = await computeDispositionFingerprint(client, id, pricing.id);
    const stageOptions = {
      approvalStage: APPROVAL_STAGE.FINAL,
      pricingId: pricing.id,
      dispositionFingerprint,
    };
    const existingSame = await repo.findApproval(
      client,
      id,
      demand.revision,
      approvalType,
      stageOptions,
    );
    if (existingSame) {
      throw new ConflictError(
        `${approvalType === APPROVAL_TYPE.MANAGEMENT_REVIEW ? "Final Management Review" : "Final Formal Approval"} has already been decided for Pricing Version ${pricing.version} and the current purchasing set.`,
      );
    }

    if (actor.role !== "CEO") {
      const otherType = OTHER_APPROVAL_TYPE[approvalType];
      const existingOther = await repo.findApproval(
        client,
        id,
        demand.revision,
        otherType,
        stageOptions,
      );
      if (existingOther?.actor_user_id === actor.id) {
        throw new ConflictError(
          "The same user cannot record both final responsibilities for one Pricing version.",
        );
      }
    }

    await repo.insertApproval(client, {
      demandId: id,
      revision: demand.revision,
      approvalStage: APPROVAL_STAGE.FINAL,
      approvalType,
      pricingId: pricing.id,
      dispositionFingerprint,
      decision,
      actorUserId: actor.id,
      reason,
    });

    await repo.insertAuditLog(client, {
      demandId: id,
      actorUserId: actor.id,
      action: finalAuditAction(approvalType, decision),
      previousStatus: demand.status,
      newStatus:
        decision === DECISION.REJECTED
          ? MATERIAL_DEMAND_STATUS.PRICING_REVISION_REQUIRED
          : demand.status,
      metadata: {
        approvalStage: APPROVAL_STAGE.FINAL,
        approvalType,
        pricingId: pricing.id,
        pricingVersion: pricing.version,
        dispositionFingerprint,
      },
    });

    if (decision === DECISION.REJECTED) {
      await repo.updateStatus(client, id, MATERIAL_DEMAND_STATUS.PRICING_REVISION_REQUIRED);
      await repo.insertAuditLog(client, {
        demandId: id,
        actorUserId: actor.id,
        action: "PRICING_REVISION_REQUIRED",
        previousStatus: demand.status,
        newStatus: MATERIAL_DEMAND_STATUS.PRICING_REVISION_REQUIRED,
        metadata: { pricingId: pricing.id, pricingVersion: pricing.version },
      });

      const procurementRecipients = await resolveEligibleRecipients({
        capabilityCode: "procurement.pricing",
        siteId: demand.site_id,
      });
      if (procurementRecipients.length > 0) {
        await enqueue(
          client,
          procurementRecipients.map((userId) => ({
            channel: "IN_APP",
            eventType: "DEMAND_PRICING_REVISION_REQUIRED",
            entityType: "MATERIAL_DEMAND",
            entityId: id,
            recipientUserId: userId,
            recipientSiteId: demand.site_id,
            idempotencyKey: `demand:${id}:rev:${demand.revision}:pricing:${pricing.version}:repricing-required:${userId}`,
            payload: {
              demandNumber: demand.demand_number,
              departmentId: demand.department_id,
              pricingVersion: pricing.version,
              message: `Pricing for ${demand.department_name} Demand ${demand.demand_number} requires revision.`,
              deepLink: `/procurement/pricing/${id}`,
            },
          })),
        );
      }
      return;
    }

    // Both responsibilities must have approved the SAME purchasing set. An
    // approval recorded before a line was excluded has a different
    // fingerprint, so it does not satisfy this — that reviewer decides again
    // on the new set, and their earlier decision stays in the history.
    const otherApproval = await repo.findApproval(
      client,
      id,
      demand.revision,
      OTHER_APPROVAL_TYPE[approvalType],
      stageOptions,
    );
    if (!otherApproval || otherApproval.decision !== DECISION.APPROVED) return;

    await repo.updateStatus(client, id, MATERIAL_DEMAND_STATUS.READY_FOR_IPO);
    await repo.insertAuditLog(client, {
      demandId: id,
      actorUserId: actor.id,
      action: "READY_FOR_IPO",
      previousStatus: demand.status,
      newStatus: MATERIAL_DEMAND_STATUS.READY_FOR_IPO,
      metadata: { pricingId: pricing.id, pricingVersion: pricing.version },
    });

    // The owner's decision: no manual "Generate IPO" step. The final approved
    // workflow produces the official IPO itself, in THIS transaction, under
    // the Demand row lock already held above — so a retry, a double-click, or
    // two approvers completing the gate concurrently can never produce two
    // IPOs (the unique (demand_id, demand_revision) index is the ultimate
    // guarantee, and generateIpoForApprovedDemand is a no-op on replay).
    // READY_FOR_IPO therefore remains a real, audited boundary in the
    // history, but is never a resting state.
    await generateIpoForApprovedDemand(client, {
      demand,
      pricing,
      // The exact set both responsibilities approved — the same value the gate
      // check immediately above matched on. Bound onto the IPO permanently so
      // its signoffs can never drift to a later, different purchasing set.
      dispositionFingerprint,
      actorId: actor.id,
    });
  });
}

export const recordFinalManagementReview = (actor, id, decision) =>
  recordFinalApprovalDecision(actor, id, APPROVAL_TYPE.MANAGEMENT_REVIEW, decision);

export const recordFinalFormalApproval = (actor, id, decision) =>
  recordFinalApprovalDecision(actor, id, APPROVAL_TYPE.FORMAL_APPROVAL, decision);

// Generated on demand from persisted data. Authorization is re-checked here
// on every download using the same assertDemandViewable rule the ordinary
// detail endpoint uses — a cross-department or cross-site Demand id is
// refused identically to a nonexistent one.
export async function generateDemandPdf(actor, id) {
  const demand = await repo.findById(id);
  if (!demand) throw new NotFoundError("Demand not found.");
  assertDemandViewable(actor, demand);

  const [lines, approvals] = await Promise.all([
    repo.findLinesByDemandId(id),
    repo.findApprovalsByDemandId(id),
  ]);

  const buffer = await generateDemandListPdf({ demand, lines, approvals });
  return { buffer, filename: documentFilename(demand.demand_number, "pdf") };
}
