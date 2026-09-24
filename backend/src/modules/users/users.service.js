import argon2 from "argon2";
import crypto from "node:crypto";
import { withTransaction } from "../../shared/db/with-transaction.js";
import { ValidationError, ConflictError, NotFoundError, ForbiddenError } from "../../shared/errors/app-error.js";
import { recordGovernanceAudit } from "../../shared/audit/governance-audit.repository.js";
import { findDepartmentById } from "../departments/departments.repository.js";
import {
  listRolePermissionCodes,
  listBundlePermissionCodes,
  findUserById,
  findRoleByName,
  emailExists,
  insertUser,
  updateUserRoleId,
  setUserActiveState,
  listUsersForSite,
  findPermissionByCode,
  listOverridesForUser,
  upsertOverride,
  deleteOverride,
  lockUserById,
  replacePasswordAndBumpSession,
  listCapabilityBundles,
  listBundleAssignmentsForUser,
  findCapabilityBundleByCode,
  insertBundleAssignment,
  deleteBundleAssignment,
} from "./users.repository.js";
import { getUserProfileById } from "../../shared/users/user-profile.repository.js";
import {
  assertDelegablePermissions,
  assertLockedGovernanceTarget,
  canDelegatePermissions,
  isReservedDelegationPermission,
  ASSIGNABLE_ROLES,
  guardGovernanceTarget,
  guardUmCreateAuthority,
  CEO_ROLE,
  UM_ROLE,
  UM_MANAGE_PERMISSION,
} from "./users.authorization.js";

// Explicit user-management authority includes the existing ordinary EMPLOYEE
// baseline (also used by Workforce onboarding), independently of the manager
// holding those operational permissions. All other role powers need a ceiling.
const ORDINARY_ROLE_PERMISSIONS = new Set([
  "profile.self.view", "profile.self.edit", "leave.self.create", "leave.self.view", "leave.self.cancel",
  "dc.view", "demand.view", "material_catalog.view", "receiving.receive", "receiving.view",
]);

// An actor without site-wide/company-wide reach can only create users
// within their own site — and an explicit mismatch is a denial, not a
// silent override, mirroring gate-pass.authorization.js's
// resolveCreateDepartmentId for the same reason (a caller who genuinely
// believed they were targeting a different site should see that, not have
// it silently discarded). CEO is company-wide, so may target any site.
function resolveCreateSiteId(actor, requestedSiteId) {
  if (actor.role === CEO_ROLE) {
    return requestedSiteId || actor.siteId;
  }

  if (requestedSiteId && requestedSiteId !== actor.siteId) {
    throw new ForbiddenError("You can only create users within your own site.");
  }

  return actor.siteId;
}

async function assertDepartmentUsable(departmentId, siteId) {
  if (!departmentId) return;

  const department = await findDepartmentById(departmentId);
  if (!department || !department.is_active || department.site_id !== siteId) {
    throw new ValidationError("Invalid department.");
  }
}

export async function createUser(actor, input) {
  if (!ASSIGNABLE_ROLES.includes(input.role)) throw new ForbiddenError("Role is not assignable.");
  await guardUmCreateAuthority(actor, input.role);

  const siteId = resolveCreateSiteId(actor, input.siteId);

  const role = await findRoleByName(input.role);
  if (!role || !role.is_active) {
    throw new ValidationError("Invalid or inactive role.");
  }

  assertDelegablePermissions(actor, (await listRolePermissionCodes(role.id)).filter((code) => !ORDINARY_ROLE_PERMISSIONS.has(code)));

  if (await emailExists(input.email)) {
    throw new ConflictError("A user with this email already exists.");
  }

  await assertDepartmentUsable(input.departmentId, siteId);

  // ESDMS-001: no invitation infrastructure — a governance-created account
  // gets a server-generated temporary password and must_change_password,
  // reusing the same forced-first-login-change mechanism Workforce
  // onboarding already relies on. The creator never chooses/sees a
  // permanent shared credential; the plaintext value below is returned in
  // this response only and is never logged or persisted anywhere.
  const temporaryPassword = crypto.randomBytes(16).toString("base64url");
  const passwordHash = await argon2.hash(temporaryPassword);

  return withTransaction(async (client) => {
    const created = await insertUser(client, {
      email: input.email,
      fullName: input.fullName,
      passwordHash,
      roleId: role.id,
      siteId,
      departmentId: input.departmentId || null,
    });

    await recordGovernanceAudit(client, {
      actorUserId: actor.id,
      targetUserId: created.id,
      action: "USER_CREATED",
      metadata: { role: input.role, siteId },
    });

    return { ...created, temporaryPassword };
  });
}

export async function listUsers(actor) {
  const siteId = actor.role === CEO_ROLE ? null : actor.siteId;
  return listUsersForSite(siteId);
}

export async function getUser(actor, targetUserId) {
  const target = await findUserById(targetUserId);
  if (!target) throw new NotFoundError("User not found.");

  if (actor.role !== CEO_ROLE && target.site_id !== actor.siteId) {
    // Same data-minimization posture as Gate Pass record-level checks:
    // a wrong-site id looks identical to a nonexistent one.
    throw new NotFoundError("User not found.");
  }

  return target;
}

export async function changeUserRole(actor, targetUserId, nextRole) {
  if (!ASSIGNABLE_ROLES.includes(nextRole)) throw new ForbiddenError("Role is not assignable.");
  const target = await getUser(actor, targetUserId);

  await guardGovernanceTarget(actor, target, {
    action: "USER_ROLE_CHANGED",
    umPermission: { code: UM_MANAGE_PERMISSION, nextRole },
  });

  if (target.role === nextRole) {
    throw new ValidationError("User already has this role.");
  }

  const role = await findRoleByName(nextRole);
  if (!role || !role.is_active) {
    throw new ValidationError("Invalid or inactive role.");
  }

  return withGovernanceMutation(actor, targetUserId, "USER_ROLE_CHANGED", async (client) => {
    await assertLockedGovernanceTarget(client, actor, await lockUserById(client, targetUserId), nextRole);
    assertDelegablePermissions(actor, (await listRolePermissionCodes(role.id, client)).filter((code) => !ORDINARY_ROLE_PERMISSIONS.has(code)));
    await updateUserRoleId(client, targetUserId, role.id);

    await recordGovernanceAudit(client, {
      actorUserId: actor.id,
      targetUserId,
      action: "USER_ROLE_CHANGED",
      metadata: { previousRole: target.role, nextRole },
    });

    return { id: targetUserId, role: nextRole };
  });
}

async function setUserActive(actor, targetUserId, isActive) {
  const target = await getUser(actor, targetUserId);

  await guardGovernanceTarget(actor, target, {
    action: isActive ? "USER_ACTIVATED" : "USER_DEACTIVATED",
    umPermission: { code: UM_MANAGE_PERMISSION, nextRole: target.role },
  });

  if (target.is_active === isActive) {
    throw new ValidationError(`User is already ${isActive ? "active" : "inactive"}.`);
  }

  return withGovernanceMutation(actor, targetUserId, "USER_ACTIVE_STATE_CHANGED", async (client) => {
    await assertLockedGovernanceTarget(client, actor, await lockUserById(client, targetUserId));
    await setUserActiveState(client, targetUserId, isActive);

    await recordGovernanceAudit(client, {
      actorUserId: actor.id,
      targetUserId,
      action: isActive ? "USER_ACTIVATED" : "USER_DEACTIVATED",
      metadata: {},
    });

    return { id: targetUserId, isActive };
  });
}

export const activateUser = (actor, targetUserId) => setUserActive(actor, targetUserId, true);
export const deactivateUser = (actor, targetUserId) => setUserActive(actor, targetUserId, false);

// Recovery path for a Governance-created account whose one-time temporary
// password was lost before first login — NOT a general password reset.
//
// guardGovernanceTarget runs first, unlocked, exactly like every other
// caller in this module (changeUserRole/setUserActive/assertOverridable) —
// its escalation-attempt audit write goes through a separate pool
// connection, which is only safe when no lock is held on the target row.
// Holding a FOR UPDATE lock on that row here and then calling it would
// deadlock: the audit INSERT needs a foreign-key share lock on the very
// row this transaction holds exclusively, while this transaction is
// awaiting that same INSERT before it can rollback and release the lock.
//
// The transaction below re-locks and re-reads the target immediately
// before mutating, and re-checks the same protected-status conditions
// against that fresh snapshot (without re-invoking guardGovernanceTarget)
// so a concurrent role/active change or first-login completion between
// the check above and the lock can't race the eligibility check — same
// reasoning as lockLinkedUserRoleAndActive in employees.service.js. The
// plaintext temporary password is returned once here and never persisted
// or audited — only the fact that a regeneration happened is recorded.
export async function regenerateTemporaryPassword(actor, targetUserId) {
  const target = await getUser(actor, targetUserId);

  await guardGovernanceTarget(actor, target, {
    action: "USER_TEMP_PASSWORD_REGENERATED",
    umPermission: { code: UM_MANAGE_PERMISSION, nextRole: target.role },
  });

  return withGovernanceMutation(actor, targetUserId, "USER_TEMP_PASSWORD_REGENERATED", async (client) => {
    const locked = await lockUserById(client, targetUserId);
    if (!locked) throw new NotFoundError("User not found.");

    // Re-run site-scope authorization against the freshly locked row, not
    // the pre-transaction snapshot from getUser() above: a delegated,
    // site-scoped actor's authority over this target can change (a site
    // transfer) between that initial read and this lock. Same
    // data-minimization posture as getUser's own site check — a target
    // that has moved out of scope looks identical to one that doesn't
    // exist, and nothing is audited here (this is an ordinary 404, not a
    // caught escalation attempt) — which also avoids the deadlock risk
    // described above of writing an audit row over a second pool
    // connection while this row's lock is held.
    if (actor.role !== CEO_ROLE && locked.site_id !== actor.siteId) {
      throw new NotFoundError("User not found.");
    }

    if (
      locked.role === CEO_ROLE ||
      locked.id === actor.id ||
      ((locked.role === UM_ROLE || target.role === UM_ROLE) && !actor.permissions.has(UM_MANAGE_PERMISSION))
    ) {
      throw new ForbiddenError();
    }

    await assertLockedGovernanceTarget(client, actor, locked);
    const profile = await getUserProfileById(targetUserId, client);
    assertDelegablePermissions(actor, profile.permissions.filter((code) => !ORDINARY_ROLE_PERMISSIONS.has(code)));

    if (!locked.must_change_password) {
      throw new ValidationError(
        "This account has already completed its first login. This is not a general password reset feature.",
      );
    }

    const temporaryPassword = crypto.randomBytes(16).toString("base64url");
    const passwordHash = await argon2.hash(temporaryPassword);

    await replacePasswordAndBumpSession(client, targetUserId, passwordHash);

    await recordGovernanceAudit(client, {
      actorUserId: actor.id,
      targetUserId,
      action: "USER_TEMP_PASSWORD_REGENERATED",
      metadata: {},
    });

    return { id: targetUserId, temporaryPassword };
  });
}

export async function getPermissionOverview(actor, targetUserId) {
  const target = await getUser(actor, targetUserId);
  // Reuses the exact same effective-permissions computation authenticate.js
  // relies on for every request — never a second, potentially-diverging
  // implementation of the same rule.
  const profile = await getUserProfileById(targetUserId);
  const overrides = await listOverridesForUser(targetUserId);
  const [availableBundles, assignedBundles] = await Promise.all([
    listCapabilityBundles(),
    listBundleAssignmentsForUser(targetUserId),
  ]);

  const assignableRoles = [];
  for (const name of ASSIGNABLE_ROLES) {
    const role = await findRoleByName(name);
    if (role?.is_active && canDelegatePermissions(actor, (await listRolePermissionCodes(role.id)).filter((code) => !ORDINARY_ROLE_PERMISSIONS.has(code))) &&
        (name !== UM_ROLE || actor.permissions.has(UM_MANAGE_PERMISSION))) assignableRoles.push(name);
  }

  return {
    canManage: actor.role === CEO_ROLE || !profile.permissions.some(isReservedDelegationPermission),
    assignableRoles,
    userId: target.id,
    role: target.role,
    effectivePermissions: profile.permissions,
    overrides: overrides.map((row) => ({
      permissionCode: row.permission_code,
      effect: row.effect,
      canEdit: canDelegatePermissions(actor, [row.permission_code]) &&
        (actor.role === CEO_ROLE || row.effect !== "DENY" || row.granted_by_user_id === actor.id),
      reason: row.reason,
      grantedBy: { id: row.granted_by_user_id, fullName: row.granted_by_full_name },
      createdAt: row.created_at,
    })),
    availableBundles: availableBundles.map((row) => ({
      code: row.code,
      displayName: row.display_name,
      description: row.description,
      permissionCodes: row.permission_codes,
      canDelegate: canDelegatePermissions(actor, row.permission_codes),
    })),
    assignedBundles: assignedBundles.map((row) => ({
      code: row.code,
      displayName: row.display_name,
      assignedAt: row.assigned_at,
      assignedBy: { id: row.assigned_by_user_id, fullName: row.assigned_by_full_name },
    })),
  };
}

async function assertOverridable(actor, targetUserId) {
  const target = await getUser(actor, targetUserId);

  await guardGovernanceTarget(actor, target, {
    action: "PERMISSION_OVERRIDE",
    umPermission: { code: UM_MANAGE_PERMISSION, nextRole: target.role },
  });

  return target;
}

export async function setPermissionOverride(actor, targetUserId, permissionCode, effect, reason) {
  const target = await assertOverridable(actor, targetUserId);

  const permission = await findPermissionByCode(permissionCode);
  if (!permission) {
    throw new ValidationError("Unknown permission code.");
  }

  return withGovernanceMutation(actor, target.id, "PERMISSION_OVERRIDE", async (client) => {
    await assertLockedGovernanceTarget(client, actor, await lockUserById(client, target.id));
    assertDelegablePermissions(actor, [permissionCode]);
    await assertOverrideEditable(client, actor, target.id, permission.id);
    await upsertOverride(client, {
      userId: target.id,
      permissionId: permission.id,
      effect,
      grantedByUserId: actor.id,
      reason,
    });

    await recordGovernanceAudit(client, {
      actorUserId: actor.id,
      targetUserId: target.id,
      action: effect === "GRANT" ? "PERMISSION_GRANTED" : "PERMISSION_DENIED",
      metadata: { permissionCode, reason: reason || null },
    });

    return { userId: target.id, permissionCode, effect };
  });
}

export async function removePermissionOverride(actor, targetUserId, permissionCode) {
  const target = await assertOverridable(actor, targetUserId);

  const permission = await findPermissionByCode(permissionCode);
  if (!permission) {
    throw new ValidationError("Unknown permission code.");
  }

  return withGovernanceMutation(actor, target.id, "PERMISSION_OVERRIDE_REMOVED", async (client) => {
    await assertLockedGovernanceTarget(client, actor, await lockUserById(client, target.id));
    assertDelegablePermissions(actor, [permissionCode]);
    await assertOverrideEditable(client, actor, target.id, permission.id);
    const removed = await deleteOverride(client, target.id, permission.id);
    if (!removed) {
      throw new NotFoundError("No override exists for this permission.");
    }

    await recordGovernanceAudit(client, {
      actorUserId: actor.id,
      targetUserId: target.id,
      action: "PERMISSION_OVERRIDE_REMOVED",
      metadata: { permissionCode },
    });

    return { userId: target.id, permissionCode };
  });
}

export async function assignCapabilityBundle(actor, targetUserId, bundleCode) {
  const target = await assertOverridable(actor, targetUserId);
  const bundle = await findCapabilityBundleByCode(bundleCode);
  if (!bundle || !bundle.is_active) throw new ValidationError("Unknown or inactive capability bundle.");

  return withGovernanceMutation(actor, target.id, "CAPABILITY_BUNDLE_ASSIGNED", async (client) => {
    await assertLockedGovernanceTarget(client, actor, await lockUserById(client, target.id));
    assertDelegablePermissions(actor, await listBundlePermissionCodes(bundle.id, client));
    const assigned = await insertBundleAssignment(client, {
      userId: target.id,
      bundleId: bundle.id,
      assignedByUserId: actor.id,
    });
    if (!assigned) throw new ConflictError("This capability bundle is already assigned.");

    await recordGovernanceAudit(client, {
      actorUserId: actor.id,
      targetUserId: target.id,
      action: "CAPABILITY_BUNDLE_ASSIGNED",
      metadata: { bundleCode: bundle.code },
    });
    return { userId: target.id, bundleCode: bundle.code };
  });
}

export async function removeCapabilityBundle(actor, targetUserId, bundleCode) {
  const target = await assertOverridable(actor, targetUserId);
  const bundle = await findCapabilityBundleByCode(bundleCode);
  if (!bundle) throw new ValidationError("Unknown capability bundle.");

  return withGovernanceMutation(actor, target.id, "CAPABILITY_BUNDLE_REMOVED", async (client) => {
    await assertLockedGovernanceTarget(client, actor, await lockUserById(client, target.id));
    assertDelegablePermissions(actor, await listBundlePermissionCodes(bundle.id, client));
    const removed = await deleteBundleAssignment(client, target.id, bundle.id);
    if (!removed) throw new NotFoundError("This capability bundle is not assigned.");

    await recordGovernanceAudit(client, {
      actorUserId: actor.id,
      targetUserId: target.id,
      action: "CAPABILITY_BUNDLE_REMOVED",
      metadata: { bundleCode: bundle.code },
    });
    return { userId: target.id, bundleCode: bundle.code };
  });
}

async function assertOverrideEditable(client, actor, userId, permissionId) {
  if (actor.role === CEO_ROLE) return;
  const result = await client.query(
    "SELECT effect, granted_by_user_id FROM user_permission_overrides WHERE user_id = $1 AND permission_id = $2",
    [userId, permissionId],
  );
  const existing = result.rows[0];
  if (existing?.effect === "DENY" && existing.granted_by_user_id !== actor.id) {
    throw new ForbiddenError("Only CEO or the author of this restriction can replace or remove it.");
  }
}

// Denial auditing must run AFTER rollback: an audit FK written on a second
// connection while the target is locked would deadlock against our own lock.
async function withGovernanceMutation(actor, targetUserId, action, callback) {
  try {
    return await withTransaction(callback);
  } catch (error) {
    if (error instanceof ForbiddenError) {
      await withTransaction((client) => recordGovernanceAudit(client, {
        actorUserId: actor.id, targetUserId, action: "PRIVILEGE_ESCALATION_ATTEMPT",
        metadata: { attemptedAction: action, violations: ["delegated_authority_boundary"] },
      }));
    }
    throw error;
  }
}
