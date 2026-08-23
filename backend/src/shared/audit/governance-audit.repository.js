// governance_audit_log is append-only at the database level (trigger —
// see migration 1787404000000_governance-foundation.js). This is the only
// place anything writes to it, so a governance action can never happen
// without a corresponding audit row: every service function either writes
// both inside the same transaction, or (for a rejected privileged attempt)
// writes the audit row and throws before any state changes.
//
// Never pass password/hash/token/cookie values into `metadata` — see
// docs/SECURITY.md and AGENTS.md §9.
//
// target_employee_id/target_contract_id (migration
// 1787406000000_workforce-protected-audit.js) let a Workforce event name
// its actual subject — a compensation record or contract, for instance,
// has no natural "target user."
export async function recordGovernanceAudit(
  clientOrPool,
  { actorUserId, targetUserId = null, targetEmployeeId = null, targetContractId = null, action, metadata = {} },
) {
  await clientOrPool.query(
    `INSERT INTO governance_audit_log (actor_user_id, target_user_id, target_employee_id, target_contract_id, action, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [actorUserId, targetUserId, targetEmployeeId, targetContractId, action, JSON.stringify(metadata)],
  );
}
