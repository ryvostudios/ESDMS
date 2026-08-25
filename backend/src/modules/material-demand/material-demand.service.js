import { withTransaction } from "../../shared/db/with-transaction.js";
import { enqueue } from "../../shared/notifications/outbox.repository.js";
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from "../../shared/errors/app-error.js";
import { findDepartmentById } from "../departments/departments.repository.js";
import {
  resolveDemandDepartmentId,
  resolveListDepartmentScope,
  assertDemandManageable,
} from "./material-demand.authorization.js";
import { TRANSITIONS, MATERIAL_DEMAND_STATUS } from "./material-demand.constants.js";
import * as repo from "./material-demand.repository.js";

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

  assertDemandManageable(actor, demand);

  const [lines, auditLog] = await Promise.all([
    repo.findLinesByDemandId(id),
    repo.findAuditLogByDemandId(id),
  ]);

  return { demand, lines, auditLog };
}

export async function listDemands(actor, filters) {
  const { departmentId, unfiltered } = resolveListDepartmentScope(actor, filters.departmentId);

  if (!unfiltered && !departmentId) {
    // A scoped actor with no department assigned has nothing to show —
    // must short-circuit here rather than pass null through, where it
    // would mean "unfiltered" (see material-demand.authorization.js).
    return { rows: [], total: 0 };
  }

  return repo.listForScope(departmentId, filters);
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

    // Reviewer routing: role + site, the same mechanism every existing
    // notification in this codebase uses (see gate-pass.service.js's
    // GATE_PASS_APPROVED -> recipientRole "GATE_GUARD"). This is correct
    // for UPPER_MANAGEMENT, whose own default scope (per Workforce
    // precedent and this V1's demand.all_departments correction) is
    // already site-scoped. It is a known, narrow, deliberately deferred
    // gap for CEO specifically: CEO's authority spans every site, but a
    // CEO account's own recipient_site_id only matches a Demand submitted
    // at that CEO's own home site — a genuinely multi-site deployment with
    // Demands at a site with no matching CEO recipient_site_id would not
    // notify CEO in-app (they can still find the Demand by browsing, since
    // their view authority is unaffected). A capability-driven (not
    // role-string-driven) notification routing mechanism is the correct
    // fix, deferred to Checkpoint 3 alongside the real review/approval
    // capabilities — see docs/PROCUREMENT_RECEIVING_SPEC.md §10 and
    // docs/DECISIONS.md.
    const payload = {
      demandNumber: demand.demand_number,
      departmentId: demand.department_id,
      submittedAt: new Date().toISOString(),
    };

    await enqueue(client, [
      {
        channel: "IN_APP",
        eventType: "DEMAND_SUBMITTED",
        entityType: "MATERIAL_DEMAND",
        entityId: id,
        recipientRole: "UPPER_MANAGEMENT",
        recipientSiteId: demand.site_id,
        idempotencyKey: `demand-submitted:${id}:UPPER_MANAGEMENT`,
        payload,
      },
      {
        channel: "IN_APP",
        eventType: "DEMAND_SUBMITTED",
        entityType: "MATERIAL_DEMAND",
        entityId: id,
        recipientRole: "CEO",
        recipientSiteId: demand.site_id,
        idempotencyKey: `demand-submitted:${id}:CEO`,
        payload,
      },
    ]);
  });
}
