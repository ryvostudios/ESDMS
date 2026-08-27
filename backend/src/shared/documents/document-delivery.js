import config from "../../config/env.js";
import { storageService } from "../storage/storage-service.js";
import { enqueue } from "../notifications/outbox.repository.js";
import { isWhatsAppDeliveryEnabled } from "../notifications/whatsapp-provider.js";
import { recordProcurementAudit } from "../audit/procurement-audit.repository.js";
import { documentFilename } from "./document-number.js";

// Storing and (optionally) sharing a finalized business document.
//
// Two guarantees this module exists to provide:
//
//  1. The business record is never at risk. Everything here runs in a
//     retryable outbox job AFTER the IPO/DC transaction has already
//     committed, so a rendering failure, a storage failure or a WhatsApp
//     failure can never roll back, delete or block an IPO or a Delivery
//     Challan. The document also stays downloadable regardless of whether
//     any message was ever delivered.
//
//  2. A delivery that was deliberately not attempted is recorded as such.
//     When the official provider is disabled or unconfigured, the delivery
//     row is written terminally as DISABLED — never left PENDING (which
//     would retry forever) and never FAILED (which would misreport a
//     configuration choice as an error).

export const DELIVERY_OUTCOME = {
  QUEUED: "QUEUED",
  DISABLED: "DISABLED",
  NOT_CONFIGURED: "NOT_CONFIGURED",
};

export async function findStoredDocument(clientOrPool, entityType, entityId) {
  const result = await clientOrPool.query(
    `SELECT id, ipo_id, entity_type, entity_id, document_number, storage_key,
            mime_type, size_bytes, checksum_sha256, generated_at
     FROM procurement_documents
     WHERE entity_type = $1 AND entity_id = $2`,
    [entityType, entityId],
  );
  return result.rows[0] || null;
}

export async function insertStoredDocument(
  client,
  { ipoId, entityType, entityId, documentNumber, storageKey, sizeBytes, checksumSha256 },
) {
  const result = await client.query(
    `INSERT INTO procurement_documents
       (ipo_id, entity_type, entity_id, document_number, storage_key, size_bytes, checksum_sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, storage_key`,
    [ipoId, entityType, entityId, documentNumber, storageKey, sizeBytes, checksumSha256],
  );
  return result.rows[0];
}

export function saveDocumentBytes(buffer, { ownerId, category }) {
  // `gatePassId` is the storage layer's generic owner-id parameter — Workforce
  // already reuses it the same way (documents.service.js). Namespacing keeps
  // procurement documents out of other modules' folders.
  return storageService.save(buffer, {
    gatePassId: ownerId,
    category,
    extension: "pdf",
    namespace: "procurement",
  });
}

// Writes exactly one delivery record per document, keyed for idempotency, and
// returns what actually happened so the caller can audit it truthfully.
export async function queueWhatsAppDocument(
  client,
  { ipoId, entityType, entityId, eventType, documentNumber, storageKey, destination, caption, siteId, actorUserId },
) {
  const enabled = isWhatsAppDeliveryEnabled();
  const outcome = !enabled
    ? DELIVERY_OUTCOME.DISABLED
    : destination
      ? DELIVERY_OUTCOME.QUEUED
      : DELIVERY_OUTCOME.NOT_CONFIGURED;

  await enqueue(client, [
    {
      channel: "WHATSAPP",
      eventType,
      entityType,
      entityId,
      recipientPhone: destination || null,
      recipientSiteId: siteId,
      // Stable per document: a retried generation job re-issues this as a
      // guaranteed no-op instead of dispatching a second real message.
      idempotencyKey: `whatsapp-document:${entityType}:${entityId}`,
      status: outcome === DELIVERY_OUTCOME.QUEUED ? undefined : "DISABLED",
      payload: {
        storageKey,
        filename: documentFilename(documentNumber, "pdf"),
        caption,
        // Why it was not attempted, so delivery history is self-explanatory.
        ...(outcome === DELIVERY_OUTCOME.QUEUED ? {} : { skippedReason: outcome }),
      },
    },
  ]);

  await recordProcurementAudit(client, {
    ipoId,
    entityType,
    entityId,
    // Attributed to the user whose action produced the document (the final
    // approver, the Procurement user who finalized the challan) — the job
    // carries that id forward rather than inventing a synthetic system actor.
    actorUserId,
    action: outcome === DELIVERY_OUTCOME.QUEUED ? "DOCUMENT_DELIVERY_QUEUED" : "DOCUMENT_DELIVERY_SKIPPED",
    metadata: { documentNumber, outcome },
  });

  return outcome;
}

export async function resolveDepartmentDestination(client, departmentId) {
  const result = await client.query("SELECT whatsapp_destination FROM departments WHERE id = $1", [
    departmentId,
  ]);
  return result.rows[0]?.whatsapp_destination || config.whatsapp.departmentDefaultDestination || null;
}
