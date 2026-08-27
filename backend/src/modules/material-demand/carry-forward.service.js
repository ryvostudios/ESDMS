import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/app-error.js";
import { resolveSupplyChainScope } from "../../shared/authorization/supply-chain-scope.js";
import pool from "../../config/database.js";
import * as repo from "./carry-forward.repository.js";

export { CARRY_FORWARD_SOURCE } from "./carry-forward.repository.js";

// What a department may still carry forward, and what it has already claimed.
//
// Availability is always source_quantity minus every ACTIVE claim, so the same
// unresolved 40 metres cannot be carried into three different Demands: the
// first claim reduces what the next one sees, and the database re-checks the
// same arithmetic under a lock when the claim is actually written.
export async function listAvailableCarryForward(actor, { departmentId, catalogEntryIds }) {
  const scope = resolveSupplyChainScope(actor);
  const targetDepartment = departmentId || scope.departmentId;

  if (!targetDepartment) return [];
  if (scope.tier === "OWN" && targetDepartment !== scope.departmentId) {
    throw new NotFoundError("Record not found.");
  }

  const entries = await pool.query(
    "SELECT id, company_item_id FROM department_material_catalog WHERE department_id = $1 AND id = ANY($2::uuid[])",
    [targetDepartment, catalogEntryIds],
  );
  const entryIdByCompanyItem = new Map(entries.rows.map((row) => [row.company_item_id, row.id]));

  const rows = await repo.findAvailableSources([...entryIdByCompanyItem.keys()], {
    siteId: scope.siteId,
    departmentId: targetDepartment,
  });

  return rows.map((row) => ({
    ...row,
    catalog_entry_id: entryIdByCompanyItem.get(row.company_item_id),
  }));
}

// Turns the carry-forward declarations on a Demand's lines into authoritative
// claims. Called from the SUBMIT transaction, under the Demand row lock.
//
// Submit — not draft — is deliberately the moment a claim becomes real. A
// reservation taken merely because someone opened a form would either leak
// (abandoned drafts holding quantity indefinitely) or need an expiry mechanism
// this scale does not justify. Submitting is when the department actually
// commits to the request, so that is when the quantity is committed too.
export async function allocateCarryForwardOnSubmit(client, demand, actorId) {
  const lines = await repo.findDemandLinesWithCarryForward(client, demand.id);
  if (lines.length === 0) return [];

  const allocations = [];

  for (const line of lines) {
    const source = await repo.findSourceById(client, line.carry_forward_source_type, line.carry_forward_source_id);

    if (!source) {
      throw new ValidationError("A carried-forward requirement is no longer available.");
    }
    // The source must belong to this department: a Demand cannot claim
    // another department's unresolved quantity.
    if (source.department_id !== demand.department_id) {
      throw new NotFoundError("Record not found.");
    }
    if (Number(line.carry_forward_quantity) > Number(source.available_quantity)) {
      throw new ConflictError(
        `Only ${source.available_quantity} of ${source.item_name_snapshot} remains available to carry forward — it has since been claimed by another Demand.`,
      );
    }

    allocations.push(
      await repo.insertAllocation(client, {
        sourceType: line.carry_forward_source_type,
        sourceId: line.carry_forward_source_id,
        departmentId: demand.department_id,
        siteId: demand.site_id,
        sourceQuantity: source.source_quantity,
        allocatedQuantity: line.carry_forward_quantity,
        targetDemandId: demand.id,
        targetDemandLineId: line.id,
        actorId,
      }),
    );
  }

  return allocations;
}

// A Demand that dies returns its claimed quantity to the pool.
export const releaseCarryForward = repo.releaseAllocationsForDemand;
export const findAllocationsForDemand = repo.findAllocationsForDemand;

// Validates the carry-forward declaration on incoming Demand lines before they
// are written. Availability is NOT enforced here — it is enforced at submit,
// where the claim actually becomes authoritative — but the source must exist,
// be of a known type, and belong to this department.
export async function assertCarryForwardLinesValid(departmentId, lines) {
  const declared = lines.filter((line) => line.carryForward);
  if (declared.length === 0) return;

  for (const line of declared) {
    const source = await repo.findSourceById(pool, line.carryForward.sourceType, line.carryForward.sourceId);

    if (!source || source.department_id !== departmentId) {
      throw new ValidationError("A carried-forward requirement is invalid for this department.");
    }
    if (Number(line.carryForward.quantity) > Number(line.quantity)) {
      throw new ValidationError(
        "The carried-forward quantity cannot exceed the quantity requested on that line.",
      );
    }
  }
}
