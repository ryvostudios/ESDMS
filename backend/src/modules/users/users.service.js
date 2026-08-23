import argon2 from "argon2";
import { withTransaction } from "../../shared/db/with-transaction.js";
import { ValidationError, ConflictError, NotFoundError, ForbiddenError } from "../../shared/errors/app-error.js";
import { recordGovernanceAudit } from "../../shared/audit/governance-audit.repository.js";
import { findDepartmentById } from "../departments/departments.repository.js";
import {
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
} from "./users.repository.js";
import { getUserProfileById } from "../../shared/users/user-profile.repository.js";
import { guardGovernanceTarget, guardUmCreateAuthority, CEO_ROLE, UM_MANAGE_PERMISSION } from "./users.authorization.js";

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
  await guardUmCreateAuthority(actor, input.role);

  const siteId = resolveCreateSiteId(actor, input.siteId);

  const role = await findRoleByName(input.role);
  if (!role || !role.is_active) {
    throw new ValidationError("Invalid or inactive role.");
  }

  if (await emailExists(input.email)) {
    throw new ConflictError("A user with this email already exists.");
  }

  await assertDepartmentUsable(input.departmentId, siteId);

  const passwordHash = await argon2.hash(input.password);

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

    return created;
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

  return withTransaction(async (client) => {
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

  return withTransaction(async (client) => {
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

export async function getPermissionOverview(actor, targetUserId) {
  const target = await getUser(actor, targetUserId);
  // Reuses the exact same effective-permissions computation authenticate.js
  // relies on for every request — never a second, potentially-diverging
  // implementation of the same rule.
  const profile = await getUserProfileById(targetUserId);
  const overrides = await listOverridesForUser(targetUserId);

  return {
    userId: target.id,
    role: target.role,
    effectivePermissions: profile.permissions,
    overrides: overrides.map((row) => ({
      permissionCode: row.permission_code,
      effect: row.effect,
      reason: row.reason,
      grantedBy: { id: row.granted_by_user_id, fullName: row.granted_by_full_name },
      createdAt: row.created_at,
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

  return withTransaction(async (client) => {
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

  return withTransaction(async (client) => {
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
