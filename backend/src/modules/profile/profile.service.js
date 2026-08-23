import { withTransaction } from "../../shared/db/with-transaction.js";
import { storageService } from "../../shared/storage/storage-service.js";
import { ValidationError, ForbiddenError, NotFoundError, ServiceUnavailableError } from "../../shared/errors/app-error.js";
import { getEmployee } from "../employees/employees.service.js";
import { recordHistory } from "../workforce/business-history.repository.js";
import { findFieldById, listFields } from "../workforce-config/workforce-config.repository.js";
import { validateCustomFieldValue } from "./custom-field-value.validation.js";
import {
  getPersonalDetails,
  upsertPersonalDetails,
  listEmergencyContacts,
  insertEmergencyContact,
  findEmergencyContact,
  updateEmergencyContact,
  deleteEmergencyContact,
  getCustomFieldValues,
  upsertCustomFieldValue,
  insertProfilePhoto,
  setCurrentPhoto,
  findCurrentPhoto,
} from "./profile.repository.js";

// getEmployee already allows unconditional self-access (identity-based, see
// workforce.authorization.js) and otherwise requires employees.view + site
// scope — every profile sub-resource below reuses that single check, then
// separately requires employees.update for a non-self actor to WRITE.
function isSelfActor(actor, employeeId) {
  return actor.employeeId === employeeId;
}

function assertWritable(actor, employee) {
  if (isSelfActor(actor, employee.id)) {
    if (!actor.permissions.has("profile.self.edit")) throw new ForbiddenError();
    return;
  }
  if (!actor.permissions.has("employees.update")) throw new ForbiddenError();
}


function canViewCustomField(actor, field, self) {
  if (self) return field.employee_can_view;
  if (actor.role === "CEO") return true;
  if (actor.role === "HR") return field.hr_can_view;
  if (actor.role === "UPPER_MANAGEMENT") return field.management_can_view;
  return false;
}

export async function getProfile(actor, employeeId) {
  const employee = await getEmployee(actor, employeeId);
  const self = isSelfActor(actor, employee.id);
  if (self && !actor.permissions.has("profile.self.view")) throw new ForbiddenError();

  const personalDetails = await getPersonalDetails(employee.id);
  const emergencyContacts = await listEmergencyContacts(employee.id);
  const rawValues = await getCustomFieldValues(employee.id);

  const values = rawValues
    .filter((row) => row.is_active && canViewCustomField(actor, row, self))
    .map((row) => ({
      fieldId: row.field_id,
      fieldKey: row.field_key,
      label: row.label,
      fieldType: row.field_type,
      value: row.value,
      updatedAt: row.updated_at,
    }));

  const completion = await computeProfileCompletion(actor, self, personalDetails, rawValues);

  return { employee, personalDetails, emergencyContacts, customFieldValues: values, completion };
}

async function computeProfileCompletion(actor, self, personalDetails, customFieldValues) {
  const requiredCoreFields = ["cnic", "mobile", "address"];
  const allFields = await listFields({ activeOnly: true });
  const completionFields = allFields.filter((f) => f.counts_toward_completion && canViewCustomField(actor, f, self));

  const coreFilled = requiredCoreFields.filter((key) => personalDetails && personalDetails[key]).length;
  const customFilled = completionFields.filter((f) =>
    customFieldValues.some((v) => v.field_id === f.id && v.value !== null && v.value !== undefined && v.value !== ""),
  ).length;

  const totalRequired = requiredCoreFields.length + completionFields.length;
  const totalFilled = coreFilled + customFilled;

  return {
    percent: totalRequired === 0 ? 100 : Math.round((totalFilled / totalRequired) * 100),
    missingCoreFields: requiredCoreFields.filter((key) => !(personalDetails && personalDetails[key])),
    missingCustomFields: completionFields
      .filter((f) => !customFieldValues.some((v) => v.field_id === f.id && v.value !== null && v.value !== undefined && v.value !== ""))
      .map((f) => ({ id: f.id, label: f.label })),
  };
}

// Explicit allowlist — the only fields this endpoint can ever write, for
// either actor. Authoritative employment data (site/department/role/
// employeeCode/etc.) has no path through here at all.
const PERSONAL_DETAIL_FIELDS = ["cnic", "mobile", "address", "personalEmail"];

// ESDMS-008: the personal-details write and its history entry commit as
// one transaction.
export async function updatePersonalDetails(actor, employeeId, input) {
  const employee = await getEmployee(actor, employeeId);
  assertWritable(actor, employee);

  const allowed = {};
  for (const key of PERSONAL_DETAIL_FIELDS) {
    if (input[key] !== undefined) allowed[key] = input[key];
  }

  return withTransaction(async (client) => {
    const updated = await upsertPersonalDetails(client, employee.id, allowed);

    await recordHistory(client, {
      employeeId: employee.id,
      eventType: "PROFILE_UPDATED",
      summary: { fields: Object.keys(allowed) },
      actorUserId: actor.id,
    });

    return updated;
  });
}

export async function addEmergencyContact(actor, employeeId, input) {
  const employee = await getEmployee(actor, employeeId);
  assertWritable(actor, employee);
  return insertEmergencyContact(employee.id, input);
}

export async function editEmergencyContact(actor, contactId, input) {
  const contact = await findEmergencyContact(contactId);
  if (!contact) throw new NotFoundError("Emergency contact not found.");
  const employee = await getEmployee(actor, contact.employee_id);
  assertWritable(actor, employee);
  return updateEmergencyContact(contactId, input);
}

export async function removeEmergencyContact(actor, contactId) {
  const contact = await findEmergencyContact(contactId);
  if (!contact) throw new NotFoundError("Emergency contact not found.");
  const employee = await getEmployee(actor, contact.employee_id);
  assertWritable(actor, employee);
  await deleteEmergencyContact(contactId);
}

export async function setCustomFieldValue(actor, employeeId, fieldId, rawValue) {
  const employee = await getEmployee(actor, employeeId);
  const self = isSelfActor(actor, employee.id);

  const field = await findFieldById(fieldId);
  if (!field || !field.is_active) throw new ValidationError("Invalid custom field.");

  const canEdit = self
    ? actor.permissions.has("profile.self.edit") && field.employee_can_edit
    : actor.permissions.has("employees.update") && (actor.role === "CEO" || (actor.role === "HR" && field.hr_can_edit));
  if (!canEdit) throw new ForbiddenError("You cannot edit this field.");

  const value = validateCustomFieldValue(field, rawValue);
  return upsertCustomFieldValue(employee.id, fieldId, value, actor.id);
}

// Same compensating-cleanup shape as gate-pass.service.js's evidence-photo
// upload: if anything in the transaction fails after the bytes are already
// written, the orphaned storage object is removed rather than left behind.
export async function uploadProfilePhoto(actor, employeeId, photo) {
  const employee = await getEmployee(actor, employeeId);
  assertWritable(actor, employee);

  let storageKey;
  try {
    const result = await withTransaction(async (client) => {
      const saved = await storageService.save(photo.buffer, {
        gatePassId: employee.id,
        category: "profile-photo",
        extension: photo.extension,
        namespace: "workforce",
      });
      storageKey = saved.storageKey;

      const photoRow = await insertProfilePhoto(client, {
        employeeId: employee.id,
        storageKey: saved.storageKey,
        mimeType: photo.mimeType,
        sizeBytes: saved.sizeBytes,
        checksumSha256: saved.checksumSha256,
        uploadedByUserId: actor.id,
      });

      await setCurrentPhoto(client, employee.id, photoRow.id);

      await recordHistory(client, {
        employeeId: employee.id,
        eventType: "PROFILE_PHOTO_REPLACED",
        summary: { version: photoRow.version },
        actorUserId: actor.id,
      });

      return photoRow;
    });
    return result;
  } catch (error) {
    if (storageKey) await storageService.remove(storageKey);
    throw error;
  }
}

export async function getProfilePhotoFile(actor, employeeId) {
  const employee = await getEmployee(actor, employeeId);
  if (isSelfActor(actor, employee.id) && !actor.permissions.has("profile.self.view")) throw new ForbiddenError();
  const photo = await findCurrentPhoto(employee.id);
  if (!photo) throw new NotFoundError("No profile photo set.");

  const buffer = await storageService.read(photo.storage_key);
  if (!storageService.verifyChecksum(buffer, photo.checksum_sha256)) {
    throw new ServiceUnavailableError("The stored profile photo failed its integrity check.");
  }
  return { buffer, mimeType: photo.mime_type };
}
