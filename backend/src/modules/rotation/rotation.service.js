import { mutateConfiguration } from "../../shared/audit/configuration-audit.js";
import { withTransaction } from "../../shared/db/with-transaction.js";
import { ForbiddenError, ValidationError, ConflictError, NotFoundError } from "../../shared/errors/app-error.js";
import { getEmployee } from "../employees/employees.service.js";
import { recordHistory } from "../workforce/business-history.repository.js";
import * as repo from "./rotation.repository.js";

function isSelfActor(actor, employeeId) {
  return actor.employeeId === employeeId;
}

export async function createPolicy(input, actor) {
  return mutateConfiguration(actor, "rotation_policies", null, client => repo.insertPolicy(input, client));
}

// Policies already used historically must not be edited in a way that
// reinterprets past ledger math — only name/active-state changes; archive
// and create a new policy for a different work/off-day split
// (docs/DECISIONS.md, same principle as workforce-config's field_type rule).
export async function updatePolicy(id, input, actor) {
  const policy = await repo.findPolicyById(id);
  if (!policy) throw new NotFoundError("Rotation policy not found.");
  if (input.isActive === false && (await repo.policyInUse(id))) {
    throw new ConflictError("Cannot archive a rotation policy with active employees assigned.");
  }
  return mutateConfiguration(actor, "rotation_policies", id, client => repo.updatePolicyFields(id, input, client));
}

export { listPolicies } from "./rotation.repository.js";

export async function getMyOrEmployeeStatus(actor, employeeId) {
  const employee = await getEmployee(actor, employeeId);
  const self = isSelfActor(actor, employee.id);
  if (!self && !actor.permissions.has("rotation.view")) throw new ForbiddenError();

  const policy = await repo.getCurrentPolicyForEmployee(employee.id);
  const balance = await repo.getBalance(employee.id);
  const ledger = await repo.listLedger(employee.id);

  return { policy, balance, ledger };
}

export async function adjustBalance(actor, employeeId, input) {
  const employee = await getEmployee(actor, employeeId);
  if (!actor.permissions.has("rotation.adjust")) throw new ForbiddenError();
  if (input.days === 0) throw new ValidationError("Adjustment amount cannot be zero.");

  return withTransaction(async (client) => {
    const entry = await repo.insertLedgerEntry(client, {
      employeeId: employee.id,
      entryType: "ADJUSTMENT",
      days: input.days,
      reason: input.reason,
      effectiveDate: input.effectiveDate,
      createdByUserId: actor.id,
    });

    await recordHistory(client, {
      employeeId: employee.id,
      eventType: "ROTATION_ADJUSTED",
      summary: { days: input.days, reason: input.reason || null },
      actorUserId: actor.id,
    });

    return entry;
  });
}
