import { ForbiddenError, NotFoundError } from "../../shared/errors/app-error.js";
import { getUserProfileById } from "../../shared/users/user-profile.repository.js";
import pool from "../../config/database.js";
import { recordGovernanceAudit } from "../../shared/audit/governance-audit.repository.js";

export const CEO_ROLE = "CEO";
export const UM_ROLE = "UPPER_MANAGEMENT";

// CEO is never assignable through this API — see docs/DECISIONS.md
// ("CEO cannot be created through ordinary public/user-management API").
export const ASSIGNABLE_ROLES = [
  "UPPER_MANAGEMENT",
  "HR",
  "EMPLOYEE",
  "ADMIN",
  "SITE_MANAGER",
  "TEAM_LEAD",
  "GATE_GUARD",
];

export const UM_CREATE_PERMISSION = "users.create_um";
export const UM_MANAGE_PERMISSION = "users.manage_um";

// Every governance write that targets an EXISTING user (role change,
// activate/deactivate, permission override grant/deny/removal) funnels
// through here first, so these invariants only need to be reasoned about
// once instead of per-endpoint:
//
//   - CEO accounts can never be touched through this API — full stop, for
//     every actor including another CEO. CEO membership changes are a
//     separate, more sensitive operation, deliberately out of scope for
//     this increment (see docs/DECISIONS.md).
//   - No actor can act on their own account here — closes "self-escalation
//     through a crafted payload" and accidental self-lockout in one rule.
//   - Touching an Upper Management account (as the current role, or as the
//     role being assigned) additionally requires the specific UM authority
//     permission for that operation — holding UPPER_MANAGEMENT itself
//     never implies it (see the governance-foundation migration).
//
// A blocked attempt is audited as PRIVILEGE_ESCALATION_ATTEMPT before the
// ForbiddenError is thrown, so a denied request is never invisible.
export async function guardGovernanceTarget(actor, targetUser, { action, umPermission } = {}) {
  const violations = [];

  if (targetUser.role === CEO_ROLE) violations.push("target_is_ceo");
  if (targetUser.id === actor.id) violations.push("self_target");
  if (
    umPermission &&
    (targetUser.role === UM_ROLE || umPermission.nextRole === UM_ROLE) &&
    !actor.permissions.has(umPermission.code)
  ) {
    violations.push("missing_um_authority");
  }

  if (violations.length === 0) return;

  await recordGovernanceAudit(pool, {
    actorUserId: actor.id,
    targetUserId: targetUser.id,
    action: "PRIVILEGE_ESCALATION_ATTEMPT",
    metadata: { attemptedAction: action, violations },
  });

  if (violations.includes("target_is_ceo")) {
    throw new ForbiddenError("CEO accounts cannot be modified through this API.");
  }
  if (violations.includes("self_target")) {
    throw new ForbiddenError("You cannot perform this action on your own account.");
  }
  throw new ForbiddenError("Managing an Upper Management account requires explicit UM authority.");
}

// Same authority rule as guardGovernanceTarget's UM branch, for the one
// governance write that has no existing target user yet: creating a new
// account with the Upper Management role.
export async function guardUmCreateAuthority(actor, requestedRole) {
  if (requestedRole !== UM_ROLE || actor.permissions.has(UM_CREATE_PERMISSION)) {
    return;
  }

  await recordGovernanceAudit(pool, {
    actorUserId: actor.id,
    action: "PRIVILEGE_ESCALATION_ATTEMPT",
    metadata: { attemptedAction: "USER_CREATED", violations: ["missing_um_authority"], requestedRole },
  });

  throw new ForbiddenError("Creating an Upper Management account requires explicit UM authority.");
}

// Delegation is bounded by effective authority, never by position/title.
// Authority to administer access is itself CEO-delegated, not transitive.
export function isReservedDelegationPermission(code) {
  return code.startsWith("users.") || code.startsWith("permission_overrides.") ||
    code.startsWith("employees.account.") || code.endsWith(".all_sites") ||
    code.endsWith(".all_departments");
}

export function canDelegatePermissions(actor, codes) {
  return actor.role === CEO_ROLE || codes.every((code) =>
    actor.permissions.has(code) && !isReservedDelegationPermission(code));
}

export function assertDelegablePermissions(actor, codes) {
  if (!canDelegatePermissions(actor, codes)) {
    throw new ForbiddenError("Delegation requires permissions you hold; governance and company-wide authority can only be delegated by CEO.");
  }
}

// Called inside the mutation transaction, AFTER locking the target User.
// No separate-connection audit while holding its FK row lock.
export async function assertLockedGovernanceTarget(client, actor, target, nextRole = target?.role) {
  if (!target || (actor.role !== CEO_ROLE && target.site_id !== actor.siteId)) {
    throw new NotFoundError("User not found.");
  }
  if (target.role === CEO_ROLE || target.id === actor.id ||
      ((target.role === UM_ROLE || nextRole === UM_ROLE) && !actor.permissions.has(UM_MANAGE_PERMISSION))) {
    throw new ForbiddenError("This account is protected from this governance action.");
  }
  if (actor.role !== CEO_ROLE) {
    const profile = await getUserProfileById(target.id, client);
    if (profile.permissions.some(isReservedDelegationPermission)) {
      throw new ForbiddenError("Only CEO can administer an account with delegated governance or company-wide authority.");
    }
  }
}
