import { z } from "zod";

const EMPLOYEE_CODE = z.string().trim().regex(/^[A-Za-z0-9_-]{2,30}$/, "Invalid employee ID format.");
const EMPLOYMENT_STATUSES = ["ACTIVE", "INACTIVE", "RESIGNED", "TERMINATED"];

export const duplicateCheckSchema = z.object({
  fullLegalName: z.string().trim().min(1).max(150),
  siteId: z.string().uuid(),
  cnic: z.string().trim().max(20).optional(),
  mobile: z.string().trim().max(30).optional(),
  personalEmail: z.string().trim().email().optional(),
});

export const createEmployeeSchema = z.object({
  employeeCode: EMPLOYEE_CODE,
  fullLegalName: z.string().trim().min(1).max(150),
  siteId: z.string().uuid().optional(),
  joiningDate: z.string().date(),
  departmentId: z.string().uuid().optional().nullable(),
  positionId: z.string().uuid().optional().nullable(),
  employmentTypeId: z.string().uuid().optional().nullable(),
  rotationPolicyId: z.string().uuid().optional().nullable(),
  reportingManagerEmployeeId: z.string().uuid().optional().nullable(),
  cnic: z.string().trim().max(20).optional(),
  mobile: z.string().trim().max(30).optional(),
  personalEmail: z.string().trim().email().optional(),
  confirmDuplicateOverride: z.boolean().optional(),
});

export const updateEmployeeSchema = z.object({
  fullLegalName: z.string().trim().min(1).max(150).optional(),
  employeeCode: EMPLOYEE_CODE.optional(),
});

export const changeStatusSchema = z.object({
  status: z.enum(EMPLOYMENT_STATUSES),
  reason: z.string().trim().max(500).optional(),
});

export const createAssignmentSchema = z.object({
  siteId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional().nullable(),
  positionId: z.string().uuid().optional().nullable(),
  employmentTypeId: z.string().uuid().optional().nullable(),
  rotationPolicyId: z.string().uuid().optional().nullable(),
  reportingManagerEmployeeId: z.string().uuid().optional().nullable(),
  effectiveDate: z.string().date(),
  reason: z.string().trim().max(500).optional(),
});

export const createLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(12, "Password must be at least 12 characters.").optional(),
});

export const listQuerySchema = z.object({
  siteId: z.string().uuid().optional(),
  status: z.enum(EMPLOYMENT_STATUSES).optional(),
  departmentId: z.string().uuid().optional(),
  positionId: z.string().uuid().optional(),
  search: z.string().trim().max(150).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
