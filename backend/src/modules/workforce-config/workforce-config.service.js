import { ValidationError, ConflictError, NotFoundError } from "../../shared/errors/app-error.js";
import * as repo from "./workforce-config.repository.js";

export async function createSection(input) {
  return repo.insertSection(input);
}

export async function updateSection(id, input) {
  const section = await repo.findSectionById(id);
  if (!section) throw new NotFoundError("Profile section not found.");
  return repo.updateSectionFields(id, input);
}

export async function createField(input) {
  const section = await repo.findSectionById(input.sectionId);
  if (!section || !section.is_active) throw new ValidationError("Invalid profile section.");
  if (await repo.fieldKeyExists(input.fieldKey)) {
    throw new ConflictError("A custom field with this key already exists.");
  }
  return repo.insertField(input);
}

// field_type is immutable once any value has been recorded — "Text -> Date"
// (etc.) would silently reinterpret existing stored values. Archive the old
// field and create a new one instead (docs/DECISIONS.md). Every other
// metadata change (label, visibility, validation additions, sort order,
// archive) is allowed freely and never invalidates existing records.
export async function updateField(id, input) {
  const field = await repo.findFieldById(id);
  if (!field) throw new NotFoundError("Custom field not found.");

  if (input.sectionId) {
    const section = await repo.findSectionById(input.sectionId);
    if (!section || !section.is_active) throw new ValidationError("Invalid profile section.");
  }

  return repo.updateFieldFields(id, input);
}

export async function createDocumentType(input) {
  if (await repo.documentTypeNameExists(input.name)) {
    throw new ConflictError("A document type with this name already exists.");
  }
  return repo.insertDocumentType(input);
}

export async function updateDocumentType(id, input) {
  const type = await repo.findDocumentTypeById(id);
  if (!type) throw new NotFoundError("Document type not found.");

  if (input.isActive === false && (await repo.documentTypeInUse(id))) {
    throw new ConflictError("Cannot archive a document type that already has uploaded documents.");
  }

  return repo.updateDocumentTypeFields(id, input);
}

function managesConfiguration(actor) {
  return actor.permissions.has("workforce.configuration.manage");
}

export async function listSectionsForActor(actor) {
  return repo.listSections({ activeOnly: !managesConfiguration(actor) });
}

export async function listFieldsForActor(actor) {
  const rows = await repo.listFields({ activeOnly: !managesConfiguration(actor) });
  if (managesConfiguration(actor)) return rows;
  const selfOnly = !actor.permissions.has("employees.view");
  return rows
    .filter((row) => selfOnly
      ? row.employee_can_view || row.employee_can_edit
      : actor.role === "UPPER_MANAGEMENT" ? row.management_can_view : row.hr_can_view)
    .map((row) => ({
      id: row.id,
      section_id: row.section_id,
      label: row.label,
      field_key: row.field_key,
      field_type: row.field_type,
      help_text: row.help_text,
      employee_can_view: selfOnly ? row.employee_can_view : undefined,
      employee_can_edit: selfOnly ? row.employee_can_edit : undefined,
      validation: row.validation,
      sort_order: row.sort_order,
    }));
}

export async function listDocumentTypesForActor(actor) {
  const rows = await repo.listDocumentTypes({ activeOnly: !managesConfiguration(actor) });
  if (managesConfiguration(actor)) return rows;
  const selfOnly = !actor.permissions.has("employees.view");
  return rows
    .filter((row) => selfOnly
      ? row.employee_can_view || row.employee_can_upload
      : row.hr_can_view || row.hr_can_upload)
    .map((row) => ({
      id: row.id,
      name: row.name,
      is_required: row.is_required,
      can_upload: selfOnly ? row.employee_can_upload : row.hr_can_upload,
      can_view: selfOnly ? row.employee_can_view : row.hr_can_view,
      expiry_required: row.expiry_required,
      verification_required: row.verification_required,
      allowed_mime_types: row.allowed_mime_types,
      sort_order: row.sort_order,
    }));
}
