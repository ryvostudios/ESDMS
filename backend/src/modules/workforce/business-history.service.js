import argon2 from "argon2";
import pool from "../../config/database.js";
import { withTransaction } from "../../shared/db/with-transaction.js";
import { ForbiddenError, NotFoundError, ConflictError, ValidationError, UnauthorizedError } from "../../shared/errors/app-error.js";
import { getEmployee } from "../employees/employees.service.js";
import { recordGovernanceAudit } from "../../shared/audit/governance-audit.repository.js";
import { listHistory, findHistoryEntryById, markHistoryRemoved } from "./business-history.repository.js";

export async function getHistory(actor, employeeId) {
  const employee = await getEmployee(actor, employeeId);
  const self = actor.employeeId === employee.id;
  if (!self && !actor.permissions.has("employees.view")) throw new ForbiddenError();
  return listHistory(employee.id);
}

// Only CEO may remove an ordinary business-history entry — enforced by
// role, not just a permission code, since "business_history.remove" is
// deliberately delegable per-user via override (see
// 1787405000000_workforce-schema-foundation.js's permission catalog) while
// this ADDITIONAL role check keeps a plain permission grant from being
// enough on its own; CEO-level removal authority stays CEO-only unless a
// future explicit delegation model changes this. The removed row is never
// deleted (DB trigger blocks it) — see docs/DECISIONS.md and
// docs/SECURITY.md.
export async function removeHistoryEntry(actor, entryId, { reason, confirmPassword }) {
  if (actor.role !== "CEO") throw new ForbiddenError("Only CEO may remove a business-history entry.");
  if (!reason || !reason.trim()) throw new ValidationError("A reason is required to remove a history entry.");

  // Strong confirmation: re-verify the acting CEO's own current password,
  // not just that their session cookie is still valid — same idea as a
  // step-up re-auth prompt before a destructive admin action.
  const current = await pool.query("SELECT password_hash FROM users WHERE id = $1", [actor.id]);
  if (!current.rows[0] || !(await argon2.verify(current.rows[0].password_hash, confirmPassword || ""))) {
    throw new UnauthorizedError("Password confirmation is incorrect.");
  }

  const entry = await findHistoryEntryById(entryId);
  if (!entry) throw new NotFoundError("History entry not found.");
  if (entry.is_removed) throw new ConflictError("This entry has already been removed.");

  return withTransaction(async (client) => {
    await markHistoryRemoved(client, entryId, { removedByUserId: actor.id, removedReason: reason });

    await recordGovernanceAudit(client, {
      actorUserId: actor.id,
      targetEmployeeId: entry.employee_id,
      action: "HISTORY_REMOVED",
      metadata: { entryId, reason: reason || null },
    });

    return { id: entryId, removed: true };
  });
}
