import { z } from "zod";

// ESDMS-018: the caller must say explicitly which catalog it wants — never
// inferred backend-side from whether the actor also happens to hold a
// management permission (see workforce-config.service.js).
export const catalogContextSchema = z.object({
  context: z.enum(["self", "management"]),
}).strict();

export const FIELD_TYPES = [
  "TEXT",
  "LONG_TEXT",
  "NUMBER",
  "DATE",
  "BOOLEAN",
  "DROPDOWN",
  "MULTI_SELECT",
  "EMAIL",
  "PHONE",
  "URL",
  "PERCENTAGE",
];

// Defense in depth: a custom field must never be able to impersonate a
// protected structured concept. The real protection is that custom-field
// VALUES have no code path into salary/contract/permission logic at all —
// this denylist just keeps the label itself from being misleading. See
// docs/DECISIONS.md.
const RESERVED_KEY_FRAGMENTS = [
  "salary",
  "compensation",
  "contract",
  "password",
  "role",
  "permission",
  "ceo",
  "token",
  "session",
  "cnic",
  "pay",
  "payroll",
  "wage",
];

export function assertFieldConceptNotReserved(value) {
  const lower = value.toLowerCase();
  return !RESERVED_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

export const createSectionSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).optional(),
  sortOrder: z.number().int().optional(),
});

export const updateSectionSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(1000).optional().nullable(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

const fieldValidationSchema = z
  .object({
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(1).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    options: z.array(z.string().trim().min(1).max(100)).max(200).optional(),
    allowFutureDate: z.boolean().optional(),
    allowPastDate: z.boolean().optional(),
  })
  .strict();

export const createFieldSchema = z.object({
  sectionId: z.string().uuid(),
  label: z.string().trim().min(1).max(150).refine(assertFieldConceptNotReserved, "This field label is reserved."),
  fieldKey: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,58}$/, "Field key must be lowercase snake_case.")
    .refine(assertFieldConceptNotReserved, "This field key is reserved."),
  fieldType: z.enum(FIELD_TYPES),
  helpText: z.string().trim().max(500).optional(),
  isRequired: z.boolean().optional(),
  employeeCanView: z.boolean().optional(),
  employeeCanEdit: z.boolean().optional(),
  hrCanView: z.boolean().optional(),
  hrCanEdit: z.boolean().optional(),
  managementCanView: z.boolean().optional(),
  isSearchable: z.boolean().optional(),
  isFilterable: z.boolean().optional(),
  isReportable: z.boolean().optional(),
  isSensitive: z.boolean().optional(),
  countsTowardCompletion: z.boolean().optional(),
  validation: fieldValidationSchema.optional(),
  sortOrder: z.number().int().optional(),
});

// field_type is deliberately excluded — see workforce-config.service.js.
export const updateFieldSchema = z.object({
  label: z.string().trim().min(1).max(150).refine(assertFieldConceptNotReserved, "This field label is reserved.").optional(),
  sectionId: z.string().uuid().optional(),
  helpText: z.string().trim().max(500).optional().nullable(),
  isRequired: z.boolean().optional(),
  employeeCanView: z.boolean().optional(),
  employeeCanEdit: z.boolean().optional(),
  hrCanView: z.boolean().optional(),
  hrCanEdit: z.boolean().optional(),
  managementCanView: z.boolean().optional(),
  isSearchable: z.boolean().optional(),
  isFilterable: z.boolean().optional(),
  isReportable: z.boolean().optional(),
  isSensitive: z.boolean().optional(),
  countsTowardCompletion: z.boolean().optional(),
  validation: fieldValidationSchema.optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

export const createDocumentTypeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  isRequired: z.boolean().optional(),
  employeeCanUpload: z.boolean().optional(),
  hrCanUpload: z.boolean().optional(),
  employeeCanView: z.boolean().optional(),
  hrCanView: z.boolean().optional(),
  expiryRequired: z.boolean().optional(),
  verificationRequired: z.boolean().optional(),
  allowedMimeTypes: z.array(z.enum(["application/pdf", "image/jpeg", "image/png", "image/webp"])).min(1).optional(),
  sortOrder: z.number().int().optional(),
});

export const updateDocumentTypeSchema = createDocumentTypeSchema.partial().extend({
  isActive: z.boolean().optional(),
});
