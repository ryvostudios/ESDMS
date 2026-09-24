import { mutateConfiguration } from "../../shared/audit/configuration-audit.js";
import { ValidationError, ConflictError, NotFoundError, ForbiddenError } from "../../shared/errors/app-error.js";
import * as repo from "./workforce-config.repository.js";

export async function createSection(input, actor) {
  return mutateConfiguration(actor, "employee_profile_sections", null, client => repo.insertSection(input, client));
}

export async function updateSection(id, input, actor) {
  const section = await repo.findSectionById(id);
  if (!section) throw new NotFoundError("Profile section not found.");
  return mutateConfiguration(actor, "employee_profile_sections", id, client => repo.updateSectionFields(id, input, client));
}

export async function createField(input, actor) {
  const section = await repo.findSectionById(input.sectionId);
  if (!section || !section.is_active) throw new ValidationError("Invalid profile section.");
  if (await repo.fieldKeyExists(input.fieldKey)) {
    throw new ConflictError("A custom field with this key already exists.");
  }
  return mutateConfiguration(actor, "employee_custom_fields", null, client => repo.insertField(input, client));
}

// field_type is immutable once any value has been recorded — "Text -> Date"
// (etc.) would silently reinterpret existing stored values. Archive the old
// field and create a new one instead (docs/DECISIONS.md). Every other
// metadata change (label, visibility, validation additions, sort order,
// archive) is allowed freely and never invalidates existing records.
export async function updateField(id, input, actor) {
  const field = await repo.findFieldById(id);
  if (!field) throw new NotFoundError("Custom field not found.");

  if (input.sectionId) {
    const section = await repo.findSectionById(input.sectionId);
    if (!section || !section.is_active) throw new ValidationError("Invalid profile section.");
  }

  return mutateConfiguration(actor, "employee_custom_fields", id, client => repo.updateFieldFields(id, input, client));
}

export async function createDocumentType(input, actor) {
  if (await repo.documentTypeNameExists(input.name)) {
    throw new ConflictError("A document type with this name already exists.");
  }
  return mutateConfiguration(actor, "employee_document_types", null, client => repo.insertDocumentType(input, client));
}

export async function updateDocumentType(id, input, actor) {
  const type = await repo.findDocumentTypeById(id);
  if (!type) throw new NotFoundError("Document type not found.");

  if (input.isActive === false && (await repo.documentTypeInUse(id))) {
    throw new ConflictError("Cannot archive a document type that already has uploaded documents.");
  }

  return mutateConfiguration(actor, "employee_document_types", id, client => repo.updateDocumentTypeFields(id, input, client));
}

function managesConfiguration(actor) {
  return actor.permissions.has("workforce.configuration.manage");
}

// ESDMS-018: "am I fetching the SELF-visible catalog or the
// MANAGEMENT-visible one" must never be inferred from which permissions an
// actor happens to hold (an HR/UM/CEO actor viewing THEIR OWN self-service
// page still needs the self catalog, not the management one, just because
// they also hold employees.view). The caller states the context explicitly;
// this only authorizes that the actor may actually use the requested context.
function assertContextUsable(actor, context) {
  if (context === "management" && !managesConfiguration(actor) && !actor.permissions.has("employees.view") && !actor.permissions.has("employees.create")) {
    throw new ForbiddenError();
  }
  // "self" has no further gate here — every authenticated Workforce actor
  // may see what's visible/editable on their own profile; whether they
  // actually have an Employee record to apply it to is checked elsewhere.
}

export async function listSectionsForActor(actor) {
  return repo.listSections({ activeOnly: !managesConfiguration(actor) });
}

export async function listFieldsForActor(actor, context) {
  assertContextUsable(actor, context);
  const rows = await repo.listFields({ activeOnly: !managesConfiguration(actor) });
  if (context === "management") {
    if (managesConfiguration(actor)) return rows;
    return rows
      .filter((row) => (actor.role === "UPPER_MANAGEMENT" ? row.management_can_view : row.hr_can_view))
      .map((row) => ({
        id: row.id,
        section_id: row.section_id,
        label: row.label,
        field_key: row.field_key,
        field_type: row.field_type,
        help_text: row.help_text,
        validation: row.validation,
        sort_order: row.sort_order,
      }));
  }

  return rows
    .filter((row) => row.employee_can_view || row.employee_can_edit)
    .map((row) => ({
      id: row.id,
      section_id: row.section_id,
      label: row.label,
      field_key: row.field_key,
      field_type: row.field_type,
      help_text: row.help_text,
      employee_can_view: row.employee_can_view,
      employee_can_edit: row.employee_can_edit,
      validation: row.validation,
      sort_order: row.sort_order,
    }));
}

export async function listDocumentTypesForActor(actor, context) {
  assertContextUsable(actor, context);
  const rows = await repo.listDocumentTypes({ activeOnly: !managesConfiguration(actor) });
  if (context === "management") {
    if (managesConfiguration(actor)) return rows;
    return rows
      .filter((row) => row.hr_can_view || row.hr_can_upload)
      .map((row) => ({
        id: row.id,
        name: row.name,
        is_required: row.is_required,
        can_upload: row.hr_can_upload,
        can_view: row.hr_can_view,
        expiry_required: row.expiry_required,
        verification_required: row.verification_required,
        allowed_mime_types: row.allowed_mime_types,
        sort_order: row.sort_order,
      }));
  }

  return rows
    .filter((row) => row.employee_can_view || row.employee_can_upload)
    .map((row) => ({
      id: row.id,
      name: row.name,
      is_required: row.is_required,
      can_upload: row.employee_can_upload,
      can_view: row.employee_can_view,
      expiry_required: row.expiry_required,
      verification_required: row.verification_required,
      allowed_mime_types: row.allowed_mime_types,
      sort_order: row.sort_order,
    }));
}
