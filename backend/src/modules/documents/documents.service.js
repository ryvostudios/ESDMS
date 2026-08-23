import pool from "../../config/database.js";
import { withTransaction } from "../../shared/db/with-transaction.js";
import { storageService } from "../../shared/storage/storage-service.js";
import { ValidationError, ForbiddenError, NotFoundError, ConflictError, ServiceUnavailableError } from "../../shared/errors/app-error.js";
import { getEmployee } from "../employees/employees.service.js";
import { recordHistory } from "../workforce/business-history.repository.js";
import { notifyEmployee } from "../workforce/workforce-notify.js";
import { findDocumentTypeById } from "../workforce-config/workforce-config.repository.js";
import {
  listLatestDocuments,
  listDocumentVersions,
  findDocumentById,
  insertDocument,
  setVerificationStatus,
  listExpiring as repoListExpiring,
  insertRequest,
  listPendingRequests,
  fulfillMatchingRequests,
  cancelRequest,
  findRequestById,
} from "./documents.repository.js";

function documentMetadata(row) {
  const { storage_key: _storageKey, checksum_sha256: _checksum, ...safe } = row;
  return safe;
}

function safeDownloadFilename(original, mimeType) {
  const fallback = `document.${mimeType.split("/")[1] || "bin"}`;
  const basename = String(original || fallback).replaceAll("\\", "/").split("/").pop();
  return basename.replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/^\.+/, "").slice(0, 180) || fallback;
}

function isSelfActor(actor, employeeId) {
  return actor.employeeId === employeeId;
}

export async function listDocuments(actor, employeeId) {
  const employee = await getEmployee(actor, employeeId);
  const self = isSelfActor(actor, employee.id);
  if (!self && !actor.permissions.has("employee_documents.view")) throw new ForbiddenError();
  const rows = await listLatestDocuments(employee.id);
  return rows.filter((row) => (self ? row.employee_can_view : row.hr_can_view)).map(documentMetadata);
}

export async function listVersions(actor, employeeId, documentTypeId) {
  const employee = await getEmployee(actor, employeeId);
  const self = isSelfActor(actor, employee.id);
  if (!self && !actor.permissions.has("employee_documents.view")) throw new ForbiddenError();
  const rows = await listDocumentVersions(employee.id, documentTypeId);
  return rows.filter((row) => (self ? row.employee_can_view : row.hr_can_view)).map(documentMetadata);
}

export async function uploadDocument(actor, employeeId, documentTypeId, file, { expiryDate } = {}) {
  const employee = await getEmployee(actor, employeeId);
  const self = isSelfActor(actor, employee.id);

  const docType = await findDocumentTypeById(documentTypeId);
  if (!docType || !docType.is_active) throw new ValidationError("Invalid document type.");

  const canUpload = self ? docType.employee_can_upload : docType.hr_can_upload && actor.permissions.has("employee_documents.manage");
  if (!canUpload) throw new ForbiddenError("You cannot upload this document type.");

  if (!docType.allowed_mime_types.includes(file.mimeType)) {
    throw new ValidationError(`This document type only accepts: ${docType.allowed_mime_types.join(", ")}.`);
  }
  if (docType.expiry_required && !expiryDate) {
    throw new ValidationError("An expiry date is required for this document type.");
  }

  let storageKey;
  try {
    return await withTransaction(async (client) => {
      const saved = await storageService.save(file.buffer, {
        gatePassId: employee.id,
        category: `document-${docType.id}`,
        extension: file.extension,
        namespace: "workforce",
      });
      storageKey = saved.storageKey;

      const inserted = await insertDocument(client, {
        employeeId: employee.id,
        documentTypeId: docType.id,
        storageKey: saved.storageKey,
        mimeType: file.mimeType,
        sizeBytes: saved.sizeBytes,
        checksumSha256: saved.checksumSha256,
        originalFilename: file.originalFilename,
        expiryDate,
        uploadedByUserId: actor.id,
      });

      await fulfillMatchingRequests(client, employee.id, docType.id, inserted.id);

      await recordHistory(client, {
        employeeId: employee.id,
        eventType: "DOCUMENT_UPLOADED",
        summary: { documentTypeId: docType.id, documentTypeName: docType.name, version: inserted.version },
        actorUserId: actor.id,
      });

      return inserted;
    });
  } catch (error) {
    if (storageKey) await storageService.remove(storageKey);
    throw error;
  }
}

export async function downloadDocument(actor, documentId) {
  const document = await findDocumentById(documentId);
  if (!document) throw new NotFoundError("Document not found.");

  const employee = await getEmployee(actor, document.employee_id);
  const self = isSelfActor(actor, employee.id);

  const docType = await findDocumentTypeById(document.document_type_id);
  const canView = self ? docType.employee_can_view : docType.hr_can_view && actor.permissions.has("employee_documents.download");
  if (!canView) throw new ForbiddenError();

  const buffer = await storageService.read(document.storage_key);
  if (!storageService.verifyChecksum(buffer, document.checksum_sha256)) {
    throw new ServiceUnavailableError("The stored document failed its integrity check.");
  }
  return { buffer, mimeType: document.mime_type, filename: safeDownloadFilename(document.original_filename, document.mime_type) };
}

export async function verifyDocument(actor, documentId, { status, remark }) {
  const document = await findDocumentById(documentId);
  if (!document) throw new NotFoundError("Document not found.");
  const employee = await getEmployee(actor, document.employee_id);

  return withTransaction(async (client) => {
    const updated = await setVerificationStatus(client, document.id, { status, verifiedByUserId: actor.id, remark });

    await recordHistory(client, {
      employeeId: employee.id,
      eventType: "DOCUMENT_VERIFIED",
      summary: { documentId: document.id, status, documentTypeName: document.document_type_name },
      actorUserId: actor.id,
    });

    return updated;
  });
}

export async function requestDocument(actor, employeeId, documentTypeId, note) {
  const employee = await getEmployee(actor, employeeId);
  const docType = await findDocumentTypeById(documentTypeId);
  if (!docType || !docType.is_active) throw new ValidationError("Invalid document type.");

  const request = await insertRequest(employee.id, docType.id, actor.id, note);
  await recordHistory(pool, {
    employeeId: employee.id,
    eventType: "DOCUMENT_REQUESTED",
    summary: { documentTypeId: docType.id },
    actorUserId: actor.id,
  });
  await notifyEmployee(pool, {
    employeeUserId: employee.user_id,
    siteId: employee.primary_site_id,
    eventType: "DOCUMENT_REQUESTED",
    entityType: "EMPLOYEE_DOCUMENT_REQUEST",
    entityId: request.id,
    payload: { documentTypeName: docType.name },
  });
  return request;
}

export async function pendingRequestsFor(actor, employeeId) {
  const employee = await getEmployee(actor, employeeId);
  if (!isSelfActor(actor, employee.id) && !actor.permissions.has("employee_documents.manage")) throw new ForbiddenError();
  return listPendingRequests(employee.id);
}

export async function cancelDocumentRequest(actor, employeeId, requestId) {
  const employee = await getEmployee(actor, employeeId);
  if (!actor.permissions.has("employee_documents.manage")) throw new ForbiddenError();
  const request = await findRequestById(requestId);
  if (!request || request.employee_id !== employee.id) throw new NotFoundError("Document request not found.");
  if (request.status !== "PENDING") throw new ConflictError("Only a pending document request can be cancelled.");
  const cancelled = await withTransaction((client) => cancelRequest(client, request.id));
  if (!cancelled) throw new ConflictError("Only a pending document request can be cancelled.");
}

export async function listExpiringDocuments(actor, withinDays = 30) {
  if (!actor.permissions.has("employee_documents.view") || !actor.permissions.has("workforce.reports.view")) {
    throw new ForbiddenError();
  }
  const scope = actor.role === "CEO" || actor.permissions.has("workforce.all_sites") ? null : actor.siteId;
  const rows = await repoListExpiring(scope, withinDays);
  return rows.filter((row) => actor.role === "CEO" || row.hr_can_view).map(documentMetadata);
}
