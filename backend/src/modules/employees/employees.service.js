import argon2 from "argon2";
import crypto from "node:crypto";
import pool from "../../config/database.js";
import { withTransaction } from "../../shared/db/with-transaction.js";
import { ValidationError, ConflictError, NotFoundError, ForbiddenError } from "../../shared/errors/app-error.js";
import { recordGovernanceAudit } from "../../shared/audit/governance-audit.repository.js";
import { recordHistory } from "../workforce/business-history.repository.js";
import { resolveCreateSiteId, employeeSiteFilter, assertEmployeeViewable, assertEmployeeManageable } from "../workforce/workforce.authorization.js";
import { findDepartmentById } from "../departments/departments.repository.js";
import { findPositionById } from "../positions/positions.repository.js";
import { findEmploymentTypeById } from "../employment-types/employment-types.repository.js";
import { findRoleByName, findUserById } from "../users/users.repository.js";
import { guardGovernanceTarget, UM_MANAGE_PERMISSION, CEO_ROLE, UM_ROLE } from "../users/users.authorization.js";
import { findPolicyById } from "../rotation/rotation.repository.js";
import {
  listEmployees as repoListEmployees,
  findEmployeeById,
  findEmployeeByUserId,
  employeeCodeExists,
  findPotentialDuplicates,
  insertEmployee,
  linkUserAccount,
  updateEmployeeStatus,
  updateEmployeeCoreFields,
  insertAssignment,
  listAssignmentHistory,
  wouldCreateReportingCycle,
} from "./employees.repository.js";

async function assertDepartmentUsable(departmentId, siteId) {
  if (!departmentId) return;
  const department = await findDepartmentById(departmentId);
  if (!department || !department.is_active || department.site_id !== siteId) {
    throw new ValidationError("Invalid department.");
  }
}

async function assertPositionUsable(positionId, siteId) {
  if (!positionId) return null;
  const position = await findPositionById(positionId);
  if (!position || !position.is_active || position.site_id !== siteId) {
    throw new ValidationError("Invalid position.");
  }
  return position;
}

function assertPositionDepartmentCoherent(position, departmentId) {
  if (position?.department_id && position.department_id !== departmentId) {
    throw new ValidationError("The selected position does not belong to the selected department.");
  }
}

async function assertEmploymentTypeUsable(employmentTypeId) {
  if (!employmentTypeId) return;
  const type = await findEmploymentTypeById(employmentTypeId);
  if (!type || !type.is_active) throw new ValidationError("Invalid employment type.");
}

async function assertRotationPolicyUsable(policyId) {
  if (!policyId) return;
  const policy = await findPolicyById(policyId);
  if (!policy || !policy.is_active) throw new ValidationError("Invalid rotation policy.");
}

async function assertReportingManagerUsable(actor, employeeId, managerId) {
  if (!managerId) return;
  const manager = await findEmployeeById(managerId);
  if (!manager || manager.status !== "ACTIVE") throw new ValidationError("Invalid reporting manager.");
  assertEmployeeViewable(actor, manager);
  if (employeeId && (await wouldCreateReportingCycle(employeeId, managerId))) {
    throw new ValidationError("This reporting-manager assignment would create a cycle.");
  }
}

async function linkedUserRole(client, userId) {
  const result = await client.query(
    "SELECT r.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1",
    [userId],
  );
  return result.rows[0]?.name || null;
}

export async function checkDuplicates(actor, input) {
  return findPotentialDuplicates({
    fullLegalName: input.fullLegalName,
    primarySiteId: input.siteId,
    cnic: input.cnic,
    mobile: input.mobile,
    personalEmail: input.personalEmail,
  });
}

export async function createEmployee(actor, input) {
  const siteId = resolveCreateSiteId(actor, input.siteId);

  if (await employeeCodeExists(input.employeeCode)) {
    throw new ConflictError("This Employee ID is already in use.");
  }

  if (!input.confirmDuplicateOverride) {
    const duplicates = await checkDuplicates(actor, { ...input, siteId });
    if (duplicates.length > 0) {
      throw new ConflictError("Possible duplicate employee record(s) found.", { duplicates });
    }
  }

  await assertDepartmentUsable(input.departmentId, siteId);
  const position = await assertPositionUsable(input.positionId, siteId);
  assertPositionDepartmentCoherent(position, input.departmentId || null);
  await assertEmploymentTypeUsable(input.employmentTypeId);
  await assertRotationPolicyUsable(input.rotationPolicyId);
  await assertReportingManagerUsable(actor, null, input.reportingManagerEmployeeId);

  return withTransaction(async (client) => {
    const employee = await insertEmployee(client, {
      employeeCode: input.employeeCode,
      fullLegalName: input.fullLegalName,
      primarySiteId: siteId,
      joiningDate: input.joiningDate,
      createdByUserId: actor.id,
    });

    if (input.cnic || input.mobile || input.personalEmail) {
      await client.query(
        `INSERT INTO employee_personal_details (employee_id, cnic, mobile, personal_email)
         VALUES ($1, $2, $3, $4)`,
        [employee.id, input.cnic || null, input.mobile || null, input.personalEmail || null],
      );
    }

    await insertAssignment(client, {
      employeeId: employee.id,
      siteId,
      departmentId: input.departmentId,
      positionId: input.positionId,
      employmentTypeId: input.employmentTypeId,
      rotationPolicyId: input.rotationPolicyId,
      reportingManagerEmployeeId: input.reportingManagerEmployeeId,
      effectiveDate: input.joiningDate,
      reason: "Initial assignment",
      createdByUserId: actor.id,
    });

    await recordHistory(client, {
      employeeId: employee.id,
      eventType: "EMPLOYEE_CREATED",
      summary: { employeeCode: employee.employee_code, siteId, duplicateOverride: Boolean(input.confirmDuplicateOverride) },
      actorUserId: actor.id,
    });

    await recordGovernanceAudit(client, {
      actorUserId: actor.id,
      targetEmployeeId: employee.id,
      action: "EMPLOYEE_CREATED",
      metadata: { employeeCode: employee.employee_code, siteId },
    });

    return employee;
  });
}

export async function listEmployeesForActor(actor, filters) {
  const scope = employeeSiteFilter(actor);
  if (scope === null && !filters.siteId) {
    // Company-wide actor with no explicit site filter: list across all
    // sites — repository treats a null siteId as "no filter."
  }

  const siteId = scope !== null ? scope : filters.siteId || null;
  const offset = (filters.page - 1) * filters.pageSize;

  return repoListEmployees({
    siteId,
    status: filters.status || null,
    departmentId: filters.departmentId || null,
    positionId: filters.positionId || null,
    search: filters.search || null,
    limit: filters.pageSize,
    offset,
  });
}

export async function getEmployee(actor, employeeId) {
  const employee = await findEmployeeById(employeeId);
  if (!employee) throw new NotFoundError("Employee not found.");
  assertEmployeeViewable(actor, employee);
  return employee;
}

export async function getMyEmployee(actor) {
  if (!actor.employeeId) throw new NotFoundError("No Employee record is linked to your account.");
  return getEmployee(actor, actor.employeeId);
}

export async function getAssignmentHistory(actor, employeeId) {
  const employee = await getEmployee(actor, employeeId);
  return listAssignmentHistory(employee.id);
}

export async function updateEmployeeCore(actor, employeeId, input) {
  const employee = await findEmployeeById(employeeId);
  if (!employee) throw new NotFoundError("Employee not found.");
  assertEmployeeManageable(actor, employee, "employees.update");

  if (input.employeeCode && input.employeeCode !== employee.employee_code && (await employeeCodeExists(input.employeeCode))) {
    throw new ConflictError("This Employee ID is already in use.");
  }

  return withTransaction(async (client) => {
    const updated = await updateEmployeeCoreFields(client, employee.id, input);

    await recordHistory(client, {
      employeeId: employee.id,
      eventType: "PROFILE_UPDATED",
      summary: { fields: Object.keys(input) },
      actorUserId: actor.id,
    });

    if (input.employeeCode && input.employeeCode !== employee.employee_code) {
      await recordGovernanceAudit(client, {
        actorUserId: actor.id,
        targetEmployeeId: employee.id,
        action: "EMPLOYEE_TRANSFERRED",
        metadata: { field: "employeeCode", previous: employee.employee_code, next: input.employeeCode },
      });
    }

    return updated;
  });
}

export async function changeEmployeeStatus(actor, employeeId, input) {
  const employee = await findEmployeeById(employeeId);
  if (!employee) throw new NotFoundError("Employee not found.");
  assertEmployeeManageable(actor, employee, "employees.status_change");

  if (employee.status === input.status) {
    throw new ValidationError(`Employee is already ${input.status}.`);
  }

  const goingInactive = ["RESIGNED", "TERMINATED", "INACTIVE"].includes(input.status);

  return withTransaction(async (client) => {
    const updated = await updateEmployeeStatus(client, employee.id, { status: input.status, statusReason: input.reason });

    await recordHistory(client, {
      employeeId: employee.id,
      eventType: "STATUS_CHANGED",
      summary: { previousStatus: employee.status, status: input.status, reason: input.reason || null },
      actorUserId: actor.id,
    });

    // Coordinate the linked login: former employees must not retain
    // application access accidentally. CEO accounts are never touched
    // through this path — an employee record linked to a CEO login must go
    // through the governance API instead (defense in depth; realistically
    // never reachable since a CEO wouldn't be onboarded through Workforce).
    if (goingInactive && employee.user_id) {
      const role = await linkedUserRole(client, employee.user_id);
      if (role !== "EMPLOYEE") {
        throw new ForbiddenError(
          "A privileged linked account cannot be deactivated through Workforce. Use the governance workflow.",
        );
      }

      await client.query("UPDATE users SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [
        employee.user_id,
      ]);
      await recordHistory(client, {
        employeeId: employee.id,
        eventType: "LOGIN_DEACTIVATED",
        summary: { reason: "employment_status_change" },
        actorUserId: actor.id,
      });
    }

    return updated;
  });
}

export async function createTransfer(actor, employeeId, input) {
  const employee = await findEmployeeById(employeeId);
  if (!employee) throw new NotFoundError("Employee not found.");
  assertEmployeeManageable(actor, employee, "employees.transfer");

  const siteId = input.siteId || employee.primary_site_id;
  if (siteId !== employee.primary_site_id) {
    const scope = employeeSiteFilter(actor);
    if (scope !== null) {
      throw new ForbiddenError("Changing an employee's primary site requires company-wide Workforce scope.");
    }
  }

  // A transfer only specifying, say, a new rotation policy must not wipe
  // out the employee's existing department/position/etc — every field not
  // explicitly provided carries forward from the current assignment. Only
  // an explicit `null` clears a field; `undefined` (not sent at all) keeps
  // the current value.
  const departmentId = input.departmentId !== undefined ? input.departmentId : employee.department_id;
  const positionId = input.positionId !== undefined ? input.positionId : employee.position_id;
  const employmentTypeId = input.employmentTypeId !== undefined ? input.employmentTypeId : employee.employment_type_id;
  const rotationPolicyId = input.rotationPolicyId !== undefined ? input.rotationPolicyId : employee.rotation_policy_id;
  const reportingManagerEmployeeId =
    input.reportingManagerEmployeeId !== undefined ? input.reportingManagerEmployeeId : employee.reporting_manager_employee_id;

  await assertDepartmentUsable(departmentId, siteId);
  const position = await assertPositionUsable(positionId, siteId);
  assertPositionDepartmentCoherent(position, departmentId || null);
  await assertEmploymentTypeUsable(employmentTypeId);
  await assertRotationPolicyUsable(rotationPolicyId);
  await assertReportingManagerUsable(actor, employee.id, reportingManagerEmployeeId);

  return withTransaction(async (client) => {
    const assignment = await insertAssignment(client, {
      employeeId: employee.id,
      siteId,
      departmentId,
      positionId,
      employmentTypeId,
      rotationPolicyId,
      reportingManagerEmployeeId,
      effectiveDate: input.effectiveDate,
      reason: input.reason,
      createdByUserId: actor.id,
    });

    if (siteId !== employee.primary_site_id) {
      await client.query("UPDATE employees SET primary_site_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [
        employee.id,
        siteId,
      ]);
    }

    await recordHistory(client, {
      employeeId: employee.id,
      eventType: "SITE_CHANGED",
      summary: {
        effectiveDate: input.effectiveDate,
        siteId,
        departmentId: input.departmentId || null,
        positionId: input.positionId || null,
        reportingManagerEmployeeId: input.reportingManagerEmployeeId || null,
        reason: input.reason || null,
      },
      actorUserId: actor.id,
    });

    await recordGovernanceAudit(client, {
      actorUserId: actor.id,
      targetEmployeeId: employee.id,
      action: "EMPLOYEE_TRANSFERRED",
      metadata: { effectiveDate: input.effectiveDate, siteId, departmentId: input.departmentId || null },
    });

    return assignment;
  });
}

export async function linkExistingUserForEmployee(actor, employeeId, input) {
  const employee = await findEmployeeById(employeeId);
  if (!employee) throw new NotFoundError("Employee not found.");

  assertEmployeeManageable(actor, employee, "employees.account.link_existing");

  if (employee.user_id) {
    throw new ConflictError("This Employee already has a linked login account.");
  }

  // Run the ordinary governance guard before taking row locks. Besides
  // enforcing the normal hierarchy rules, this preserves the existing
  // denied-attempt audit behavior without making that audit compete with
  // our own FOR UPDATE lock.
  const targetPreview = await findUserById(input.userId);
  if (!targetPreview) throw new NotFoundError("User not found.");

  await guardGovernanceTarget(actor, targetPreview, {
    action: "EMPLOYEE_EXISTING_USER_LINK",
    umPermission: { code: UM_MANAGE_PERMISSION },
  });

  try {
    return await withTransaction(async (client) => {
      const targetResult = await client.query(
        `SELECT u.id, u.email, u.full_name, u.is_active, u.department_id,
                u.site_id, u.created_at, r.name AS role
         FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE u.id = $1
         FOR UPDATE OF u`,
        [input.userId],
      );

      const targetUser = targetResult.rows[0];
      if (!targetUser) throw new NotFoundError("User not found.");

      // Re-check the governance invariants under the User row lock in case
      // the account changed between the initial guard and this transaction.
      const violations = [];
      if (targetUser.role === CEO_ROLE) violations.push("target_is_ceo");
      if (targetUser.id === actor.id) violations.push("self_target");
      if (
        targetUser.role === UM_ROLE &&
        !actor.permissions.has(UM_MANAGE_PERMISSION)
      ) {
        violations.push("missing_um_authority");
      }

      if (violations.length > 0) {
        await recordGovernanceAudit(client, {
          actorUserId: actor.id,
          targetUserId: targetUser.id,
          action: "PRIVILEGE_ESCALATION_ATTEMPT",
          metadata: {
            attemptedAction: "EMPLOYEE_EXISTING_USER_LINK",
            violations,
          },
        });

        if (violations.includes("target_is_ceo")) {
          throw new ForbiddenError("CEO accounts cannot be modified through this API.");
        }
        if (violations.includes("self_target")) {
          throw new ForbiddenError("You cannot perform this action on your own account.");
        }
        throw new ForbiddenError(
          "Managing an Upper Management account requires explicit UM authority.",
        );
      }

      if (!targetUser.is_active) {
        throw new ValidationError("An inactive User account cannot be linked to an Employee.");
      }

      if (targetUser.site_id !== employee.primary_site_id) {
        throw new ValidationError("The User account and Employee must belong to the same site.");
      }

      const alreadyLinked = await client.query(
        "SELECT id FROM employees WHERE user_id = $1 LIMIT 1",
        [targetUser.id],
      );

      if (alreadyLinked.rowCount > 0) {
        throw new ConflictError("This User account is already linked to another Employee.");
      }

      const linked = await linkUserAccount(client, employee.id, targetUser.id);

      if (!linked) {
        throw new ConflictError("This Employee already has a linked login account.");
      }

      await recordGovernanceAudit(client, {
        actorUserId: actor.id,
        targetEmployeeId: employee.id,
        targetUserId: targetUser.id,
        action: "EMPLOYEE_EXISTING_USER_LINKED",
        metadata: {
          role: targetUser.role,
          email: targetUser.email,
        },
      });

      await recordHistory(client, {
        employeeId: employee.id,
        eventType: "LOGIN_LINKED_EXISTING",
        summary: {
          userId: targetUser.id,
          email: targetUser.email,
          role: targetUser.role,
        },
        actorUserId: actor.id,
      });

      return {
        employeeId: employee.id,
        userId: targetUser.id,
        email: targetUser.email,
        role: targetUser.role,
      };
    });
  } catch (error) {
    if (error?.code === "23505") {
      throw new ConflictError("This User account is already linked to another Employee.");
    }
    throw error;
  }
}

// Narrow, single-purpose: role is ALWAYS EMPLOYEE — never accepts a role
// from the caller, unlike the governance createUser service. This is what
// makes "HR cannot manipulate the payload to create a privileged role"
// true by construction rather than by a runtime check. See docs/DECISIONS.md.
export async function createLoginForEmployee(actor, employeeId, input) {
  const employee = await findEmployeeById(employeeId);
  if (!employee) throw new NotFoundError("Employee not found.");
  assertEmployeeManageable(actor, employee, "employees.account.create");

  if (employee.user_id) {
    throw new ConflictError("This Employee already has a linked login account.");
  }

  const existingEmail = await pool.query("SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)", [input.email]);
  if (existingEmail.rowCount > 0) {
    throw new ConflictError("A user with this email already exists.");
  }

  const employeeRole = await findRoleByName("EMPLOYEE");
  if (!employeeRole || !employeeRole.is_active) {
    throw new ValidationError("The EMPLOYEE role is not available.");
  }

  const temporaryPassword = input.password || crypto.randomBytes(16).toString("base64url");
  const passwordHash = await argon2.hash(temporaryPassword);

  return withTransaction(async (client) => {
    const created = await client.query(
      `INSERT INTO users (email, password_hash, full_name, role_id, site_id, is_active, must_change_password)
       VALUES ($1, $2, $3, $4, $5, true, true)
       RETURNING id`,
      [input.email, passwordHash, employee.full_legal_name, employeeRole.id, employee.primary_site_id],
    );
    const userId = created.rows[0].id;

    const linked = await linkUserAccount(client, employee.id, userId);
    if (!linked) {
      throw new ConflictError("This Employee already has a linked login account.");
    }

    await recordGovernanceAudit(client, {
      actorUserId: actor.id,
      targetEmployeeId: employee.id,
      targetUserId: userId,
      action: "USER_CREATED",
      metadata: { role: "EMPLOYEE", viaWorkforceOnboarding: true },
    });

    await recordHistory(client, {
      employeeId: employee.id,
      eventType: "LOGIN_CREATED",
      summary: { email: input.email },
      actorUserId: actor.id,
    });

    // Never returned/logged again after this response — see
    // docs/SECURITY.md and AGENTS.md §9.
    return { userId, email: input.email, temporaryPassword };
  });
}

export async function resetEmployeeLoginPassword(actor, employeeId) {
  const employee = await findEmployeeById(employeeId);
  if (!employee) throw new NotFoundError("Employee not found.");
  assertEmployeeManageable(actor, employee, "employees.account.reset");

  if (!employee.user_id) {
    throw new ValidationError("This Employee has no linked login account.");
  }

  const temporaryPassword = crypto.randomBytes(16).toString("base64url");
  const passwordHash = await argon2.hash(temporaryPassword);

  return withTransaction(async (client) => {
    const role = await linkedUserRole(client, employee.user_id);
    if (role !== "EMPLOYEE") {
      throw new ForbiddenError(
        "A privileged linked account cannot be reset through Workforce. Use the governance workflow.",
      );
    }

    await client.query(
      `UPDATE users
       SET password_hash = $2, must_change_password = true, session_version = session_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [employee.user_id, passwordHash],
    );

    await recordHistory(client, {
      employeeId: employee.id,
      eventType: "LOGIN_PASSWORD_RESET",
      summary: {},
      actorUserId: actor.id,
    });

    return { temporaryPassword };
  });
}

export async function findEmployeeForUser(userId) {
  return findEmployeeByUserId(userId);
}
