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
import { currentDateInAppTimezone } from "../../shared/time/app-timezone.js";
import {
  listEmployees as repoListEmployees,
  findEmployeeById,
  findEmployeeByUserId,
  employeeCodeExists,
  findPotentialDuplicates,
  insertEmployee,
  lockEmployeeById,
  findCurrentAssignmentFields,
  linkUserAccount,
  updateEmployeeStatus,
  updateEmployeeCoreFields,
  insertAssignment,
  listAssignmentHistory,
  wouldCreateReportingCycle,
  acquireReportingHierarchyLock,
  listActiveSites,
} from "./employees.repository.js";

// Add Employee's site-first step: an all-site actor picks from every
// active site; a site-scoped actor has nothing to pick (their one site is
// implicit), but the same shape is returned for a uniform frontend contract.
export async function listSites(actor) {
  return listActiveSites(employeeSiteFilter(actor));
}

// ESDMS-033: the only status transitions this pilot supports. Anything not
// listed here — most notably reactivating a RESIGNED/TERMINATED record — is
// explicitly rejected rather than silently allowed; formal rehire/
// employment-period modeling is deferred (docs/DECISIONS.md).
const ALLOWED_STATUS_TRANSITIONS = {
  ACTIVE: ["INACTIVE", "RESIGNED", "TERMINATED"],
  INACTIVE: ["ACTIVE"],
  RESIGNED: [],
  TERMINATED: [],
};

function assertValidStatusTransition(fromStatus, toStatus) {
  const allowed = ALLOWED_STATUS_TRANSITIONS[fromStatus] || [];
  if (!allowed.includes(toStatus)) {
    throw new ValidationError(`Cannot change Employee status from ${fromStatus} to ${toStatus}.`);
  }
}

// ESDMS-002: an out-of-scope match is disclosed only as a single boolean —
// never id, code, name, status, department, site, or even how many such
// matches exist (an array of per-match redacted placeholders would still
// leak the count via its length). Scope is always derived from the actor's
// own resolved site (employeeSiteFilter), never a client-supplied value.
function buildDuplicateCheckResult(actor, duplicates) {
  const scope = employeeSiteFilter(actor);
  const matches = [];
  let outsideScopeMatch = false;

  for (const row of duplicates) {
    if (scope === null || row.primary_site_id === scope) {
      const { primary_site_id, ...visible } = row;
      matches.push(visible);
    } else {
      outsideScopeMatch = true;
    }
  }

  return { matches, outsideScopeMatch };
}

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

// `client` defaults to `pool` only for a caller with no transaction context
// at all (there are none left as of ADV-PRE-04 — every actual mutation
// path now passes its transaction client). Every caller that goes on to
// actually WRITE this manager assignment must pass that transaction
// client, so the manager's authoritative row is locked (not read from a
// global-pool snapshot) and the advisory lock + cycle check run inside the
// very same transaction as the write — see acquireReportingHierarchyLock.
//
// ADV-PRE-04: the previous version read the manager via the unlocked
// global-pool findEmployeeById before acquiring anything, so a concurrent
// status change (Governance/offboarding making the manager non-ACTIVE)
// between that read and this transaction's commit could let an assignment
// commit against a manager who was no longer ACTIVE by the time it
// mattered. Locking the manager row (FOR UPDATE) inside this transaction
// closes that: whichever transaction — this one, or the concurrent status
// change — reaches the row lock first determines the outcome. If this one
// locks first, it validly commits using that (still-authoritative, not
// stale) ACTIVE row; the status change simply applies after. If the
// status change locks first, this transaction blocks until it commits,
// then reads the now-current (non-ACTIVE) row and rejects. Either way,
// never a stale ACTIVE snapshot.
async function assertReportingManagerUsable(actor, employeeId, managerId, client = pool) {
  if (!managerId) return;

  if (client === pool) {
    const manager = await findEmployeeById(managerId);
    if (!manager || manager.status !== "ACTIVE") throw new ValidationError("Invalid reporting manager.");
    assertEmployeeViewable(actor, manager);
    return;
  }

  // Lock order: the reporting-hierarchy advisory lock FIRST, before any
  // employee row lock (including the manager's, locked next) — the same
  // deadlock-safe ordering createTransfer's own comment documents. Taking
  // this global, transaction-scoped lock before touching any employee row
  // means only one mutation in this family ever proceeds to lock a row at
  // all, so two concurrent callers (e.g. reciprocal transfers) can never
  // deadlock waiting on each other's row lock. Reentrant within the same
  // transaction — createTransfer already holds it by the time it calls
  // this function, so re-acquiring here is a no-op, not a self-deadlock.
  await acquireReportingHierarchyLock(client);

  const manager = await lockEmployeeById(client, managerId);
  if (!manager || manager.status !== "ACTIVE") throw new ValidationError("Invalid reporting manager.");
  assertEmployeeViewable(actor, manager);

  if (employeeId && (await wouldCreateReportingCycle(client, employeeId, managerId))) {
    throw new ValidationError("This reporting-manager assignment would create a cycle.");
  }
}

// Locks the User row (FOR UPDATE OF u) for the duration of the caller's
// transaction — used wherever the role/active-state READ and a subsequent
// conditional WRITE (or WRITE decision) on that same row must be atomic
// against a concurrent Governance mutation (changeEmployeeStatus,
// createTransfer, resetEmployeeLoginPassword).
// Deliberately two queries, not one FOR UPDATE ... JOIN: after this lock
// blocks behind a concurrent transaction that changed the row, Postgres's
// EvalPlanQual re-check re-fetches the locked `users` row but does not
// reliably re-resolve a joined table's row against it in the same query,
// producing a false "no row" result even though the just-locked row and
// the referenced role both genuinely exist (confirmed empirically). Lock
// `users` alone first, then resolve the role name in a separate, ordinary
// read against the just-locked row's own current role_id.
async function lockLinkedUserRoleAndActive(client, userId) {
  const locked = await client.query("SELECT role_id, is_active, site_id FROM users WHERE id = $1 FOR UPDATE", [userId]);
  const row = locked.rows[0];
  if (!row) return null;

  const role = await client.query("SELECT name FROM roles WHERE id = $1", [row.role_id]);
  return { role: role.rows[0]?.name || null, is_active: row.is_active, site_id: row.site_id };
}

export async function checkDuplicates(actor, input) {
  // Never trust a client-supplied site to establish scope: the site used
  // both for the "same site name" match and for redaction is the actor's
  // own resolved create-site (ESDMS-002).
  const siteId = resolveCreateSiteId(actor, input.siteId);
  const duplicates = await findPotentialDuplicates({
    fullLegalName: input.fullLegalName,
    primarySiteId: siteId,
    cnic: input.cnic,
    mobile: input.mobile,
    personalEmail: input.personalEmail,
  });
  return buildDuplicateCheckResult(actor, duplicates);
}

export async function createEmployee(actor, input) {
  const siteId = resolveCreateSiteId(actor, input.siteId);

  if (await employeeCodeExists(input.employeeCode)) {
    throw new ConflictError("This Employee ID is already in use.");
  }

  if (!input.confirmDuplicateOverride) {
    const duplicateResult = await checkDuplicates(actor, { ...input, siteId });
    if (duplicateResult.matches.length > 0 || duplicateResult.outsideScopeMatch) {
      throw new ConflictError("Possible duplicate employee record(s) found.", duplicateResult);
    }
  }

  await assertDepartmentUsable(input.departmentId, siteId);
  const position = await assertPositionUsable(input.positionId, siteId);
  assertPositionDepartmentCoherent(position, input.departmentId || null);
  await assertEmploymentTypeUsable(input.employmentTypeId);
  await assertRotationPolicyUsable(input.rotationPolicyId);

  return withTransaction(async (client) => {
    // ADV-PRE-04: the manager's ACTIVE status must be read from a row
    // this transaction locks, not a global-pool snapshot taken before the
    // transaction opened — see assertReportingManagerUsable. employeeId
    // is null (a brand-new employee can't already be part of a reporting
    // chain), so this only locks the manager and checks its status; no
    // cycle check runs.
    await assertReportingManagerUsable(actor, null, input.reportingManagerEmployeeId, client);

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

  const goingInactive = ["RESIGNED", "TERMINATED", "INACTIVE"].includes(input.status);

  return withTransaction(async (client) => {
    // ESDMS-033: authoritative current status comes from the locked row,
    // not the value read before this transaction began — a concurrent
    // status change can't be raced past.
    const locked = await lockEmployeeById(client, employee.id);
    if (!locked) throw new NotFoundError("Employee not found.");

    // TOCTOU: re-run the actor's permission/site-scope authorization
    // against the LOCKED, current row — not the value read before this
    // transaction began. If the Employee moved to another site between the
    // initial (pre-lock) check and this lock, a stale same-site
    // authorization must not carry over.
    assertEmployeeManageable(actor, locked, "employees.status_change");

    if (locked.status === input.status) {
      throw new ValidationError(`Employee is already ${input.status}.`);
    }
    assertValidStatusTransition(locked.status, input.status);

    // Lock order: Employee first, then the linked User — locked/reloaded
    // once, under this same transaction, before any privilege/account-
    // state decision is made. A concurrent Governance role promotion or
    // (re)activation can't race past this: it either committed before this
    // SELECT ... FOR UPDATE (and is seen here) or blocks behind this
    // transaction's row lock until this one commits/rolls back. Both the
    // block-check below and the deactivation decision after the mutation
    // read from this single locked snapshot — never a second, separately
    // timed read that could itself observe a different state.
    const lockedLinkedUser = locked.user_id ? await lockLinkedUserRoleAndActive(client, locked.user_id) : null;

    // ESDMS-005: Employee status and application User security are separate
    // concepts. An ACTIVE privileged (non-EMPLOYEE) linked login blocks the
    // whole offboarding — it must be deactivated through Governance first.
    // An already-inactive privileged login (Governance already acted) does
    // not block offboarding, and is never touched here. CEO accounts are
    // covered by the same "privileged" branch (defense in depth; a CEO
    // wouldn't realistically be linked through Workforce at all).
    if (goingInactive && lockedLinkedUser && lockedLinkedUser.role !== "EMPLOYEE" && lockedLinkedUser.is_active) {
      throw new ForbiddenError(
        "The linked application account holds a privileged role and is still active. Deactivate it through Governance before offboarding this Employee.",
      );
    }

    const updated = await updateEmployeeStatus(client, locked.id, { status: input.status, statusReason: input.reason });

    await recordHistory(client, {
      employeeId: locked.id,
      eventType: "STATUS_CHANGED",
      summary: { previousStatus: locked.status, status: input.status, reason: input.reason || null },
      actorUserId: actor.id,
    });

    // Only an ordinary EMPLOYEE-role linked login is auto-coordinated;
    // reactivating (INACTIVE -> ACTIVE) never touches the linked User —
    // security account activation stays an explicit Governance operation.
    // Reuses the SAME locked snapshot taken above — not a fresh read.
    if (goingInactive && lockedLinkedUser && lockedLinkedUser.role === "EMPLOYEE" && lockedLinkedUser.is_active) {
      await client.query("UPDATE users SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [
        locked.user_id,
      ]);
      await recordHistory(client, {
        employeeId: locked.id,
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
  assertEmployeeManageable(actor, employee, "employees.transfer"); // early UX signal only — re-checked below

  return withTransaction(async (client) => {
    // Reporting-hierarchy advisory lock is acquired FIRST, before the
    // Employee row lock below — not just the Employee-row lock ordering
    // this function otherwise follows. A transfer's own INSERT sets
    // reporting_manager_employee_id, whose FK requires a share lock on the
    // MANAGER's employee row; two reciprocal transfers (A -> manager B,
    // B -> manager A) each already hold FOR UPDATE on their own subject
    // row, so if the advisory lock were acquired after that row lock, each
    // transaction could end up waiting on the advisory lock (held by the
    // other) while the other waits on the first's row lock for the FK
    // check — a genuine deadlock (reproduced empirically). Taking the
    // globally-serializing advisory lock first means only one transfer at a
    // time ever proceeds to lock any employee row at all, so that cycle
    // can't form.
    await acquireReportingHierarchyLock(client);

    // Lock order: Employee first (among the per-employee row locks).
    const locked = await lockEmployeeById(client, employee.id);
    if (!locked) throw new NotFoundError("Employee not found.");

    // TOCTOU: re-authorize against the locked, current row — a stale
    // same-site decision from before the lock must not carry over if the
    // Employee moved sites in the meantime.
    assertEmployeeManageable(actor, locked, "employees.transfer");

    // Re-derive current assignment fields fresh, from locked/current DB
    // state — not the pre-transaction snapshot, which a concurrent
    // transfer could have already superseded.
    const current = await findCurrentAssignmentFields(client, locked.id);

    // Lock order: linked User second — locked/reloaded once here (if any)
    // and reused for every privilege/site decision below, never a fresh,
    // unlocked read taken later.
    const lockedLinkedUser = locked.user_id ? await lockLinkedUserRoleAndActive(client, locked.user_id) : null;

    const siteId = input.siteId || locked.primary_site_id;
    const isSiteChange = siteId !== locked.primary_site_id;

    if (isSiteChange) {
      const scope = employeeSiteFilter(actor);
      if (scope !== null) {
        throw new ForbiddenError("Changing an employee's primary site requires company-wide Workforce scope.");
      }
      // ESDMS-006: a future-dated cross-site transfer must not corrupt the
      // employee's CURRENT authorization scope today. No scheduler exists yet
      // for these, so they are rejected outright rather than silently applied
      // early or accepted and ignored.
      if (input.effectiveDate > currentDateInAppTimezone()) {
        throw new ValidationError(
          "A cross-site transfer cannot be scheduled for a future date. Use today's date for an effective transfer.",
        );
      }
      // A privileged, active linked User is NEVER silently moved (see the
      // sync/never-touch split below) — so if it would become
      // site-inconsistent as a result of this transfer, block the transfer
      // itself instead. Already-inactive, or already at the target site,
      // does not block.
      if (
        lockedLinkedUser &&
        lockedLinkedUser.role !== "EMPLOYEE" &&
        lockedLinkedUser.is_active &&
        lockedLinkedUser.site_id !== siteId
      ) {
        throw new ForbiddenError(
          "The linked application account holds a privileged role and is still active. Its site cannot be changed by Workforce — adjust it through Governance before transferring this Employee to another site.",
        );
      }
    }

    // A transfer only specifying, say, a new rotation policy must not wipe
    // out the employee's existing department/position/etc — every field not
    // explicitly provided carries forward from the current assignment. Only
    // an explicit `null` clears a field; `undefined` (not sent at all) keeps
    // the current value.
    const departmentId = input.departmentId !== undefined ? input.departmentId : current.department_id ?? null;
    const positionId = input.positionId !== undefined ? input.positionId : current.position_id ?? null;
    const employmentTypeId = input.employmentTypeId !== undefined ? input.employmentTypeId : current.employment_type_id ?? null;
    const rotationPolicyId = input.rotationPolicyId !== undefined ? input.rotationPolicyId : current.rotation_policy_id ?? null;
    const reportingManagerEmployeeId =
      input.reportingManagerEmployeeId !== undefined
        ? input.reportingManagerEmployeeId
        : current.reporting_manager_employee_id ?? null;

    await assertDepartmentUsable(departmentId, siteId);
    const position = await assertPositionUsable(positionId, siteId);
    assertPositionDepartmentCoherent(position, departmentId || null);
    await assertEmploymentTypeUsable(employmentTypeId);
    await assertRotationPolicyUsable(rotationPolicyId);
    await assertReportingManagerUsable(actor, locked.id, reportingManagerEmployeeId, client);

    const assignment = await insertAssignment(client, {
      employeeId: locked.id,
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

    let linkedAccountNote = null;
    if (isSiteChange) {
      await client.query("UPDATE employees SET primary_site_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [
        locked.id,
        siteId,
      ]);

      if (lockedLinkedUser?.role === "EMPLOYEE") {
        // Safe to synchronize: an ordinary self-service account has no
        // authority tied to site beyond scoping its own record. Clear a
        // now-mismatched department_id in the same statement so this
        // never trips the department/site composite FK.
        await client.query(
          `UPDATE users
           SET site_id = $2,
               department_id = CASE
                 WHEN department_id IN (SELECT id FROM departments WHERE site_id = $2) THEN department_id
                 ELSE NULL
               END,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [locked.user_id, siteId],
        );
      } else if (lockedLinkedUser) {
        // Privileged account, but not active (otherwise blocked above) —
        // never silently touched either way. Governance must adjust its
        // site scope separately if that's still required.
        linkedAccountNote =
          "The linked application account holds a privileged role; its own site scope was not changed. Adjust it through Governance if required.";
      }
    }

    await recordHistory(client, {
      employeeId: locked.id,
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
      targetEmployeeId: locked.id,
      action: "EMPLOYEE_TRANSFERRED",
      metadata: { effectiveDate: input.effectiveDate, siteId, departmentId: input.departmentId || null },
    });

    return linkedAccountNote ? { ...assignment, linkedAccountNote } : assignment;
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

  // ADV-P1-05: a violation caught under the target User row lock below
  // must not write its PRIVILEGE_ESCALATION_ATTEMPT audit through this
  // same transaction — that write needs a second pool connection whose FK
  // check can block on the very row this transaction holds FOR UPDATE
  // (the same deadlock pattern documented on regenerateTemporaryPassword
  // in users.service.js). But writing it over a second connection while
  // still holding that lock is exactly that deadlock. So: capture what to
  // audit, let the ForbiddenError below roll the transaction back (which
  // releases the lock and discards the mutation, same as before), and
  // write the ONE denial row after rollback, in the catch below — by then
  // recordGovernanceAudit(pool, ...) is exactly as safe as the pre-lock
  // guard's own audit write above.
  let deferredDenialAudit = null;

  try {
    return await withTransaction(async (client) => {
      // ESDMS-004: reload/lock the Employee itself under the transaction —
      // status, linkage, and primary site must all be re-derived from
      // authoritative current state, not the value read before this
      // transaction began.
      const lockedEmployee = await lockEmployeeById(client, employee.id);
      if (!lockedEmployee) throw new NotFoundError("Employee not found.");

      // TOCTOU: re-run authorization against the locked, current row — a
      // stale same-site decision from before the lock must not carry over
      // if the Employee moved sites in the meantime.
      assertEmployeeManageable(actor, lockedEmployee, "employees.account.link_existing");

      if (lockedEmployee.status !== "ACTIVE") {
        throw new ValidationError("Only an ACTIVE employee can be linked to a login account.");
      }
      if (lockedEmployee.user_id) {
        throw new ConflictError("This Employee already has a linked login account.");
      }

      // Two queries, not one FOR UPDATE ... JOIN: discovered while proving
      // ADV-P1-05's real concurrency test — after this lock blocks behind a
      // concurrent role change and then resumes, Postgres's EvalPlanQual
      // recheck re-fetches the locked `users` row but does not reliably
      // re-resolve the JOINed `roles` row against it in the same query,
      // producing a false "0 rows" result even though both the just-locked
      // user and its (new) role genuinely exist — same failure mode
      // lockLinkedUserRoleAndActive above already works around for the
      // identical reason. Lock `users` alone first, then resolve the role
      // name in a separate, ordinary read against the just-locked row.
      const lockedTarget = await client.query(
        `SELECT id, email, full_name, is_active, department_id, site_id, created_at, role_id
         FROM users WHERE id = $1 FOR UPDATE`,
        [input.userId],
      );
      const targetRow = lockedTarget.rows[0];
      if (!targetRow) throw new NotFoundError("User not found.");

      const roleResult = await client.query("SELECT name FROM roles WHERE id = $1", [targetRow.role_id]);
      const targetUser = { ...targetRow, role: roleResult.rows[0]?.name || null };

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
        deferredDenialAudit = {
          actorUserId: actor.id,
          targetUserId: targetUser.id,
          action: "PRIVILEGE_ESCALATION_ATTEMPT",
          metadata: {
            attemptedAction: "EMPLOYEE_EXISTING_USER_LINK",
            violations,
          },
        };

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

      if (targetUser.site_id !== lockedEmployee.primary_site_id) {
        throw new ValidationError("The User account and Employee must belong to the same site.");
      }

      const alreadyLinked = await client.query(
        "SELECT id FROM employees WHERE user_id = $1 LIMIT 1",
        [targetUser.id],
      );

      if (alreadyLinked.rowCount > 0) {
        throw new ConflictError("This User account is already linked to another Employee.");
      }

      const linked = await linkUserAccount(client, lockedEmployee.id, targetUser.id);

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
    // The transaction has already rolled back by this point (withTransaction
    // ran ROLLBACK before rethrowing) — the target User's row lock is
    // released, so this write can't deadlock the way it would have from
    // inside that transaction. Exactly one audit row for exactly one denial.
    if (deferredDenialAudit) {
      await recordGovernanceAudit(pool, deferredDenialAudit);
    }
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
  if (employee.status !== "ACTIVE") {
    throw new ValidationError("Only an ACTIVE employee can be issued a login.");
  }

  const employeeRole = await findRoleByName("EMPLOYEE");
  if (!employeeRole || !employeeRole.is_active) {
    throw new ValidationError("The EMPLOYEE role is not available.");
  }

  const temporaryPassword = input.password || crypto.randomBytes(16).toString("base64url");
  const passwordHash = await argon2.hash(temporaryPassword);

  try {
    return await withTransaction(async (client) => {
      // ESDMS-004: re-derive status and linkage under the row lock — the
      // checks above are only an early UX signal, not the authoritative
      // gate.
      const lockedEmployee = await lockEmployeeById(client, employee.id);
      if (!lockedEmployee) throw new NotFoundError("Employee not found.");

      // TOCTOU: re-run authorization against the locked, current row — a
      // stale same-site decision from before the lock must not carry over
      // if the Employee moved sites in the meantime.
      assertEmployeeManageable(actor, lockedEmployee, "employees.account.create");

      if (lockedEmployee.status !== "ACTIVE") {
        throw new ValidationError("Only an ACTIVE employee can be issued a login.");
      }
      if (lockedEmployee.user_id) {
        throw new ConflictError("This Employee already has a linked login account.");
      }

      const created = await client.query(
        `INSERT INTO users (email, password_hash, full_name, role_id, site_id, is_active, must_change_password)
         VALUES ($1, $2, $3, $4, $5, true, true)
         RETURNING id`,
        [input.email, passwordHash, lockedEmployee.full_legal_name, employeeRole.id, lockedEmployee.primary_site_id],
      );
      const userId = created.rows[0].id;

      const linked = await linkUserAccount(client, lockedEmployee.id, userId);
      if (!linked) {
        throw new ConflictError("This Employee already has a linked login account.");
      }

      await recordGovernanceAudit(client, {
        actorUserId: actor.id,
        targetEmployeeId: lockedEmployee.id,
        targetUserId: userId,
        action: "USER_CREATED",
        metadata: { role: "EMPLOYEE", viaWorkforceOnboarding: true },
      });

      await recordHistory(client, {
        employeeId: lockedEmployee.id,
        eventType: "LOGIN_CREATED",
        summary: { email: input.email },
        actorUserId: actor.id,
      });

      // Never returned/logged again after this response — see
      // docs/SECURITY.md and AGENTS.md §9.
      return { userId, email: input.email, temporaryPassword };
    });
  } catch (error) {
    if (error?.code === "23505") {
      throw new ConflictError("A user with this email already exists.");
    }
    throw error;
  }
}

export async function resetEmployeeLoginPassword(actor, employeeId) {
  const employee = await findEmployeeById(employeeId);
  if (!employee) throw new NotFoundError("Employee not found.");
  assertEmployeeManageable(actor, employee, "employees.account.reset"); // early UX signal only — re-checked below

  return withTransaction(async (client) => {
    // Lock order: Employee first, then the linked User — same pattern as
    // changeEmployeeStatus/createTransfer, for the same reason: a
    // concurrent Governance role promotion on the linked User must either
    // have already committed before this Employee lock (and is then seen
    // fresh below) or block behind this transaction's row lock until it
    // commits/rolls back — never a decision made from stale, unlocked
    // reads taken before this transaction began.
    const locked = await lockEmployeeById(client, employee.id);
    if (!locked) throw new NotFoundError("Employee not found.");

    // TOCTOU: re-authorize against the LOCKED, current row — a stale
    // same-site decision from before the lock must not carry over if the
    // Employee moved sites in the meantime.
    assertEmployeeManageable(actor, locked, "employees.account.reset");

    if (!locked.user_id) {
      throw new ValidationError("This Employee has no linked login account.");
    }

    // Lock order: linked User second — locked/reloaded here, under this
    // same transaction, before the privilege decision below. Reuses the
    // exact same helper (and posture) as changeEmployeeStatus: only an
    // ordinary EMPLOYEE-role linked login is ever in scope for a Workforce
    // credential reset. A privileged/non-EMPLOYEE account — whether it
    // already was one, or was just promoted by a Governance transaction
    // that committed while this one was blocked on the lock — is rejected
    // and left entirely untouched; that path is Governance's, not
    // Workforce's (and is a separate feature — see
    // regenerateTemporaryPassword in users.service.js — not duplicated
    // here).
    const lockedLinkedUser = await lockLinkedUserRoleAndActive(client, locked.user_id);
    if (!lockedLinkedUser || lockedLinkedUser.role !== "EMPLOYEE") {
      throw new ForbiddenError(
        "A privileged linked account cannot be reset through Workforce. Use the governance workflow.",
      );
    }

    const temporaryPassword = crypto.randomBytes(16).toString("base64url");
    const passwordHash = await argon2.hash(temporaryPassword);

    await client.query(
      `UPDATE users
       SET password_hash = $2, must_change_password = true, session_version = session_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [locked.user_id, passwordHash],
    );

    await recordHistory(client, {
      employeeId: locked.id,
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
