import { ForbiddenError, ValidationError, NotFoundError, ConflictError } from "../../shared/errors/app-error.js";
import { getEmployee } from "../employees/employees.service.js";
import { recordHistory } from "../workforce/business-history.repository.js";
import { notifyEmployee } from "../workforce/workforce-notify.js";
import pool from "../../config/database.js";
import * as repo from "./leave.repository.js";

function isSelfActor(actor, employeeId) {
  return actor.employeeId === employeeId;
}

export async function createType(input) {
  return repo.insertType(input);
}

export async function updateType(id, input) {
  const type = await repo.findTypeById(id);
  if (!type) throw new NotFoundError("Leave type not found.");
  return repo.updateTypeFields(id, input);
}

export { listTypes } from "./leave.repository.js";

function daysBetweenInclusive(startDate, endDate) {
  const ms = new Date(endDate) - new Date(startDate);
  return Math.round(ms / (24 * 60 * 60 * 1000)) + 1;
}

export async function submitLeave(actor, employeeId, input) {
  const employee = await getEmployee(actor, employeeId);
  if (!isSelfActor(actor, employee.id)) {
    throw new ForbiddenError("Leave can only be submitted by the employee themselves.");
  }
  if (!actor.permissions.has("leave.self.create")) throw new ForbiddenError();

  const type = await repo.findTypeById(input.leaveTypeId);
  if (!type || !type.is_active) throw new ValidationError("Invalid leave type.");
  if (input.endDate < input.startDate) throw new ValidationError("End date must not be before start date.");

  const span = daysBetweenInclusive(input.startDate, input.endDate);
  if (input.requestedDays > span) throw new ValidationError("Requested days cannot exceed the date range.");

  const request = await repo.insertRequest(employee.id, input);
  await recordHistory(pool, {
    employeeId: employee.id,
    eventType: "LEAVE_SUBMITTED",
    summary: { leaveTypeId: input.leaveTypeId, startDate: input.startDate, endDate: input.endDate },
    actorUserId: actor.id,
  });
  return request;
}

export async function listMyOrEmployeeLeave(actor, employeeId) {
  const employee = await getEmployee(actor, employeeId);
  if (!isSelfActor(actor, employee.id) && !actor.permissions.has("leave.approve") && !actor.permissions.has("leave.manage")) {
    throw new ForbiddenError();
  }
  return repo.listForEmployee(employee.id);
}

export async function listPending(actor) {
  if (!actor.permissions.has("leave.approve")) throw new ForbiddenError();
  const scope = actor.role === "CEO" || actor.permissions.has("workforce.all_sites") ? null : actor.siteId;
  return repo.listPendingForSite(scope);
}

// Explicit state transitions only — no arbitrary status PATCH. An actor
// can never decide their own leave request, mirroring the self-block
// pattern used across governance/compensation.
export async function decideLeave(actor, requestId, { status, remark }) {
  if (!actor.permissions.has("leave.approve")) throw new ForbiddenError();

  const request = await repo.findRequestById(requestId);
  if (!request) throw new NotFoundError("Leave request not found.");
  if (isSelfActor(actor, request.employee_id)) {
    throw new ForbiddenError("You cannot decide your own leave request.");
  }
  if (request.status !== "SUBMITTED") throw new ConflictError("This request has already been decided.");

  const employee = await getEmployee(actor, request.employee_id);
  const updated = await repo.decide(requestId, { status, decidedByUserId: actor.id, remark });
  if (!updated) throw new ConflictError("This request has already been decided.");

  await recordHistory(pool, {
    employeeId: employee.id,
    eventType: status === "APPROVED" ? "LEAVE_APPROVED" : "LEAVE_REJECTED",
    summary: { requestId, remark: remark || null },
    actorUserId: actor.id,
  });

  await notifyEmployee(pool, {
    employeeUserId: employee.user_id,
    siteId: employee.primary_site_id,
    eventType: status === "APPROVED" ? "LEAVE_APPROVED" : "LEAVE_REJECTED",
    entityType: "LEAVE_REQUEST",
    entityId: requestId,
    payload: { status },
  });

  return updated;
}

export async function cancelMyLeave(actor, requestId) {
  if (!actor.employeeId) throw new NotFoundError("No Employee record is linked to your account.");
  const updated = await repo.cancel(requestId, actor.employeeId);
  if (!updated) throw new ConflictError("Only your own SUBMITTED request can be cancelled.");
  return updated;
}
