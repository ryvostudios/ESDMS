import { withTransaction } from "../../shared/db/with-transaction.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../shared/errors/app-error.js";
import { getEmployee } from "../employees/employees.service.js";
import { lockEmployeeById } from "../employees/employees.repository.js";
import { recordHistory } from "../workforce/business-history.repository.js";
import { recordGovernanceAudit } from "../../shared/audit/governance-audit.repository.js";
import { getCurrent, listHistory, insertRecord, isEarlierThanCurrent } from "./compensation.repository.js";

function isSelfActor(actor, employeeId) {
  return actor.employeeId === employeeId;
}

// An employee can always see their own current/historical compensation —
// that is ordinary, expected self-service, not the confidentiality concern
// the spec describes ("HR/UM/Site Manager/CFO/Admin" seeing OTHER
// employees' salaries by default). Anyone else needs the explicit,
// CEO-controlled compensation.view / compensation.history permission — see
// docs/DECISIONS.md.
async function assertViewable(actor, employee, permissionCode) {
  if (isSelfActor(actor, employee.id)) return;
  if (!actor.permissions.has(permissionCode)) throw new ForbiddenError();
}

export async function getCurrentCompensation(actor, employeeId) {
  const employee = await getEmployee(actor, employeeId);
  await assertViewable(actor, employee, "compensation.view");
  return getCurrent(employee.id);
}

export async function getCompensationHistory(actor, employeeId) {
  const employee = await getEmployee(actor, employeeId);
  await assertViewable(actor, employee, "compensation.history");
  return listHistory(employee.id);
}

// No actor may record their own compensation change, regardless of which
// permissions they hold — including CEO. Mirrors the governance module's
// universal self-mutation block (users.authorization.js) for the same
// reason: prevents any actor from unilaterally giving themselves a raise.
export async function recordCompensation(actor, employeeId, input) {
  const employee = await getEmployee(actor, employeeId);
  if (!actor.permissions.has("compensation.change")) throw new ForbiddenError();
  if (isSelfActor(actor, employee.id)) {
    throw new ForbiddenError("You cannot record your own compensation change.");
  }

  return withTransaction(async (client) => {
    // Serializes compensation writes for THIS employee, and only this one.
    // Sharing the transaction's client is not by itself enough: under READ
    // COMMITTED (the default) each transaction takes a fresh snapshot per
    // statement, so two concurrent writers both read the same current
    // record, both pass the guard below, and both insert — leaving a record
    // earlier than the one that became current. Holding the Employee row
    // FOR UPDATE makes the second writer block until the first commits and
    // then re-read the now-current record, so it is rejected.
    //
    // The Employee row is the right thing to lock rather than the current
    // compensation row: an employee with no compensation yet has no such
    // row to lock, and that first-ever insert needs serializing too.
    // Locked AFTER authorization above, and released by the COMMIT/ROLLBACK
    // in withTransaction. Reuses the same lock helper (and so the same lock
    // ordering) as employees.service.js's own transactions.
    const locked = await lockEmployeeById(client, employee.id);
    if (!locked) throw new NotFoundError("Employee not found.");

    // Evaluated while the lock is held, on the transaction's own client, so
    // the guard, the insert and the lock all belong to one transaction. An
    // equal effective date stays allowed — only strictly earlier than the
    // current record is rejected.
    if (await isEarlierThanCurrent(client, employee.id, input.effectiveDate)) {
      throw new ValidationError("Effective date cannot be earlier than the current compensation record.");
    }

    const record = await insertRecord(client, {
      employeeId: employee.id,
      amount: input.amount,
      currency: input.currency,
      effectiveDate: input.effectiveDate,
      reason: input.reason,
      createdByUserId: actor.id,
    });

    // Never include the amount itself in either history/audit metadata —
    // see docs/SECURITY.md and AGENTS.md §9's sensitive-value handling.
    await recordHistory(client, {
      employeeId: employee.id,
      eventType: "COMPENSATION_CHANGED",
      summary: { effectiveDate: input.effectiveDate },
      actorUserId: actor.id,
    });

    await recordGovernanceAudit(client, {
      actorUserId: actor.id,
      targetEmployeeId: employee.id,
      action: "COMPENSATION_RECORDED",
      metadata: { effectiveDate: input.effectiveDate },
    });

    return record;
  });
}
