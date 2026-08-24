import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError } from "../../shared/errors/app-error.js";
import * as service from "./employees.service.js";
import * as importService from "./employee-import.service.js";
import { extractEmployeeImport } from "./employee-import.upload.js";
import {
  duplicateCheckSchema,
  createEmployeeSchema,
  updateEmployeeSchema,
  changeStatusSchema,
  createAssignmentSchema,
  createLoginSchema,
  linkExistingUserSchema,
  listQuerySchema,
} from "./employees.validation.js";

function parseBody(schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid request.", parsed.error.flatten());
  return parsed.data;
}

function toEmployeeDto(row) {
  return {
    id: row.id,
    employeeCode: row.employee_code,
    fullLegalName: row.full_legal_name,
    primarySiteId: row.primary_site_id,
    status: row.status,
    joiningDate: row.joining_date,
    hasLogin: Boolean(row.user_id),
    departmentId: row.department_id,
    departmentName: row.department_name,
    positionId: row.position_id,
    positionName: row.position_name,
    employmentTypeId: row.employment_type_id,
    employmentTypeName: row.employment_type_name,
    reportingManagerEmployeeId: row.reporting_manager_employee_id,
  };
}

export const checkDuplicates = asyncHandler(async (req, res) => {
  const input = parseBody(duplicateCheckSchema, req.body);
  const duplicates = await service.checkDuplicates(req.user, input);
  res.status(200).json({ success: true, data: duplicates });
});

export const create = asyncHandler(async (req, res) => {
  const input = parseBody(createEmployeeSchema, req.body);
  const created = await service.createEmployee(req.user, input);
  res.status(201).json({ success: true, data: toEmployeeDto({ ...created, department_id: null, position_id: null }) });
});

export const list = asyncHandler(async (req, res) => {
  const filters = parseBody(listQuerySchema, req.query);
  const { rows, total } = await service.listEmployeesForActor(req.user, filters);
  res.status(200).json({
    success: true,
    data: rows.map(toEmployeeDto),
    meta: { page: filters.page, pageSize: filters.pageSize, total },
  });
});

// REM-02: Workforce dashboard's total + status breakdown, from one
// coherent DB snapshot — see countEmployeesByStatusForActor.
export const statusSummary = asyncHandler(async (req, res) => {
  const result = await service.countEmployeesByStatusForActor(req.user);
  res.status(200).json({ success: true, data: result });
});

export const detail = asyncHandler(async (req, res) => {
  const employee = await service.getEmployee(req.user, req.params.id);
  res.status(200).json({ success: true, data: toEmployeeDto(employee) });
});

export const myEmployee = asyncHandler(async (req, res) => {
  const employee = await service.getMyEmployee(req.user);
  res.status(200).json({ success: true, data: toEmployeeDto(employee) });
});

export const listSites = asyncHandler(async (req, res) => {
  const rows = await service.listSites(req.user);
  res.status(200).json({ success: true, data: rows });
});

export const assignmentHistory = asyncHandler(async (req, res) => {
  const history = await service.getAssignmentHistory(req.user, req.params.id);
  res.status(200).json({ success: true, data: history });
});

export const update = asyncHandler(async (req, res) => {
  const input = parseBody(updateEmployeeSchema, req.body);
  const updated = await service.updateEmployeeCore(req.user, req.params.id, input);
  res.status(200).json({ success: true, data: updated });
});

export const changeStatus = asyncHandler(async (req, res) => {
  const input = parseBody(changeStatusSchema, req.body);
  const updated = await service.changeEmployeeStatus(req.user, req.params.id, input);
  res.status(200).json({ success: true, data: updated });
});

export const transfer = asyncHandler(async (req, res) => {
  const input = parseBody(createAssignmentSchema, req.body);
  const created = await service.createTransfer(req.user, req.params.id, input);
  res.status(201).json({ success: true, data: created });
});

export const linkExistingUser = asyncHandler(async (req, res) => {
  const input = parseBody(linkExistingUserSchema, req.body);
  const result = await service.linkExistingUserForEmployee(req.user, req.params.id, input);
  res.status(200).json({ success: true, data: result });
});

export const createLogin = asyncHandler(async (req, res) => {
  const input = parseBody(createLoginSchema, req.body);
  const result = await service.createLoginForEmployee(req.user, req.params.id, input);
  res.status(201).json({ success: true, data: result });
});

export const resetLoginPassword = asyncHandler(async (req, res) => {
  const result = await service.resetEmployeeLoginPassword(req.user, req.params.id);
  res.status(200).json({ success: true, data: result });
});

export const importTemplate = asyncHandler(async (req, res) => {
  const { buffer, filename } = await importService.generateImportTemplate(req.user);
  res.set({
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "private, no-store",
  });
  res.status(200).send(Buffer.from(buffer));
});

export const previewImport = asyncHandler(async (req, res) => {
  const result = await importService.previewEmployeeImport(req.user, extractEmployeeImport(req));
  res.set("Cache-Control", "private, no-store");
  res.status(200).json({ success: true, data: result });
});

export const confirmImport = asyncHandler(async (req, res) => {
  const result = await importService.confirmEmployeeImport(
    req.user,
    extractEmployeeImport(req),
    req.body.confirmationToken,
    req.body.confirmWarnings,
  );
  res.set("Cache-Control", "private, no-store");
  res.status(201).json({ success: true, data: result });
});
