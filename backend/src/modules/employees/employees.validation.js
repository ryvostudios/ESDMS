import { z } from "zod";
import { optionalQueryValue } from "../../shared/http/query-validation.js";

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

const PERMANENT_OFFBOARDING_STATUSES = ["RESIGNED", "TERMINATED"];

export const changeStatusSchema = z
  .object({
    status: z.enum(EMPLOYMENT_STATUSES),
    reason: z.string().trim().max(500).optional(),
  })
  .refine(
    (data) => !PERMANENT_OFFBOARDING_STATUSES.includes(data.status) || (data.reason && data.reason.trim().length >= 3),
    { message: "A reason of at least 3 characters is required for this status change.", path: ["reason"] },
  );

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

export const linkExistingUserSchema = z.object({
  userId: z.string().uuid(),
});

export const createLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(12, "Password must be at least 12 characters.").optional(),
});

export const listQuerySchema = z.object({
  siteId: optionalQueryValue(z.string().uuid()),
  status: optionalQueryValue(z.enum(EMPLOYMENT_STATUSES)),
  departmentId: optionalQueryValue(z.string().uuid()),
  positionId: optionalQueryValue(z.string().uuid()),
  search: optionalQueryValue(z.string().trim().max(150)),
  page: optionalQueryValue(z.coerce.number().int().min(1)).default(1),
  pageSize: optionalQueryValue(z.coerce.number().int().min(1).max(100)).default(25),
}).strict();
