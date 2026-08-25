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
import { TRANSITIONS, MATERIAL_DEMAND_STATUS, APPROVAL_TYPE, APPROVAL_PERMISSION, DECISION } from "./material-demand.constants.js";
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

  const [lines, auditLog, approvals] = await Promise.all([
    repo.findLinesByDemandId(id),
    repo.findAuditLogByDemandId(id),
    repo.findApprovalsByDemandId(id),
  ]);

  return { demand, lines, auditLog, approvals };
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
