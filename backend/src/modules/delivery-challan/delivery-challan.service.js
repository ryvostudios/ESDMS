import pool from "../../config/database.js";
import { withTransaction } from "../../shared/db/with-transaction.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../shared/errors/app-error.js";
import { enqueue } from "../../shared/notifications/outbox.repository.js";
import { resolveEligibleRecipients } from "../../shared/notifications/recipient-resolver.js";
import { recordProcurementAudit } from "../../shared/audit/procurement-audit.repository.js";
import { storageService } from "../../shared/storage/storage-service.js";
import {
  registerEntityRecheckHandler,
  registerSystemJobHandler,
} from "../../shared/notifications/outbox.processor.js";
import {
  findStoredDocument,
  insertStoredDocument,
  queueWhatsAppDocument,
  resolveDepartmentDestination,
  saveDocumentBytes,
} from "../../shared/documents/document-delivery.js";
import { documentFilename, nextDocumentNumber } from "../../shared/documents/document-number.js";
import {
  assertSupplyChainRecordVisible,
  resolveSupplyChainScope,
} from "../../shared/authorization/supply-chain-scope.js";
import { IPO_STATUS } from "../ipo/ipo.constants.js";
import * as ipoRepo from "../ipo/ipo.repository.js";
import { DC_DOCUMENT_TYPE, DC_MANAGE_PERMISSION, DC_STATUS, DC_VIEW_PERMISSION } from "./delivery-challan.constants.js";
import { generateDeliveryChallanPdf } from "./delivery-challan.pdf.js";
import * as repo from "./delivery-challan.repository.js";

const ENTITY_TYPE = "DELIVERY_CHALLAN";

function assertCanView(actor) {
  if (!actor.permissions.has(DC_VIEW_PERMISSION) && !actor.permissions.has(DC_MANAGE_PERMISSION)) {
    throw new ForbiddenError();
  }
}

function assertCanManage(actor) {
  if (!actor.permissions.has(DC_MANAGE_PERMISSION)) {
    throw new ForbiddenError();
  }
}

// Resolves the requested lines against the IPO's own lines and against what
// is still unallocated. Both this and every purchasing write hold the IPO row
// lock, so "still unallocated" cannot change underneath the check; the
// database trigger re-checks the same invariant as a second line of defense.
async function resolveAllocatableLines(client, ipoId, requestedLines, { excludeDcId = null } = {}) {
  const ipoLines = await ipoRepo.lockIpoLines(client, ipoId);
  const byId = new Map(ipoLines.map((line) => [line.id, line]));

  const allocatedResult = await client.query(
    `SELECT dcl.ipo_line_id, COALESCE(SUM(dcl.quantity), 0)::numeric(12,2) AS allocated
     FROM delivery_challan_lines dcl
     JOIN delivery_challans dc ON dc.id = dcl.dc_id
     WHERE dcl.ipo_id = $1 AND dc.status <> 'CANCELLED' AND ($2::uuid IS NULL OR dcl.dc_id <> $2)
     GROUP BY dcl.ipo_line_id`,
    [ipoId, excludeDcId],
  );
  const allocated = new Map(allocatedResult.rows.map((row) => [row.ipo_line_id, Number(row.allocated)]));

  const snapshotResult = await client.query(
    `SELECT id, item_name_snapshot, uom_code_snapshot, uom_name_snapshot FROM ipo_lines WHERE ipo_id = $1`,
    [ipoId],
  );
  const snapshots = new Map(snapshotResult.rows.map((row) => [row.id, row]));

  return requestedLines.map((requested) => {
    const ipoLine = byId.get(requested.ipoLineId);
    if (!ipoLine) {
      throw new ValidationError("One or more lines do not belong to this IPO.");
    }

    const remaining = Number(ipoLine.purchased_quantity) - (allocated.get(requested.ipoLineId) || 0);
    if (Number(requested.quantity) > remaining) {
      throw new ValidationError(
        "A Delivery Challan cannot deliver more than the quantity actually purchased and not already on another challan.",
      );
    }

    return { ...requested, ...snapshots.get(requested.ipoLineId) };
  });
}

export async function listDeliveryChallans(actor, query) {
  assertCanView(actor);
  const scope = resolveSupplyChainScope(actor);

  if (scope.tier === "OWN" && !scope.departmentId) return { rows: [], total: 0 };
  if (query.departmentId && scope.tier === "OWN" && query.departmentId !== scope.departmentId) {
    throw new NotFoundError("Record not found.");
  }

  return repo.listDcs({ siteId: scope.siteId, departmentId: query.departmentId || scope.departmentId }, query);
}

export async function getDcDetail(actor, id) {
  assertCanView(actor);
  const dc = await repo.findDcById(pool, id);
  if (!dc) throw new NotFoundError("Delivery Challan not found.");
  assertSupplyChainRecordVisible(actor, dc);

  const lines = await repo.findDcLines(pool, id);
  return { deliveryChallan: dc, lines };
}

export async function createDeliveryChallan(actor, input) {
  assertCanManage(actor);

  const id = await withTransaction(async (client) => {
    const ipo = await ipoRepo.lockIpoById(client, input.ipoId);
    if (!ipo) throw new NotFoundError("IPO not found.");
    assertSupplyChainRecordVisible(actor, ipo);

    // Replay of the same logical shipment: answer with the challan that
    // already exists rather than cutting a second one. Checked under the IPO
    // row lock, so two concurrent identical requests serialize and the second
    // finds the first's committed row. The unique index on operation_id is
    // the ultimate guarantee.
    //
    // An operation id identifies one logical request, and a request is only
    // "the same" if it is against the same parent. Reusing an id under a
    // DIFFERENT IPO is a client bug (or an attempt to probe), never a replay:
    // silently handing back the other IPO's challan would report a shipment
    // as delivered that was never cut, and would do so with a 201.
    //
    // The parent check comes FIRST and the message names nothing, so an id
    // guessed from outside the actor's scope reveals only that it is in use —
    // which global uniqueness makes unavoidable — and never which IPO,
    // department or site owns it.
    const existing = await repo.findDcByOperationId(client, input.operationId);
    if (existing) {
      if (existing.ipo_id !== input.ipoId) {
        throw new ConflictError("This operation identifier has already been used for another request.");
      }

      assertSupplyChainRecordVisible(actor, existing);
      return existing.id;
    }

    if (ipo.status === IPO_STATUS.CANCELLED) {
      throw new ConflictError("A Delivery Challan cannot be created against a cancelled IPO.");
    }
    if (ipo.status === IPO_STATUS.COMPLETED) {
      throw new ConflictError("This IPO is already completed.");
    }

    const lines = await resolveAllocatableLines(client, ipo.id, input.lines);
    const dcNumber = await nextDocumentNumber(client, DC_DOCUMENT_TYPE);
    const dc = await repo.insertDc(client, {
      dcNumber,
      ipoId: ipo.id,
      departmentId: ipo.department_id,
      siteId: ipo.site_id,
      note: input.note,
      actorId: actor.id,
      operationId: input.operationId,
    });
    await repo.replaceDcLines(client, dc.id, ipo.id, lines);

    await recordProcurementAudit(client, {
      ipoId: ipo.id,
      entityType: ENTITY_TYPE,
      entityId: dc.id,
      actorUserId: actor.id,
      action: "DC_CREATED",
      newStatus: DC_STATUS.DRAFT,
      metadata: { dcNumber: dc.dc_number, lineCount: lines.length },
    });

    return dc.id;
  });

  return getDcDetail(actor, id);
}

export async function updateDraft(actor, id, input) {
  assertCanManage(actor);

  await withTransaction(async (client) => {
    const dcPreview = await repo.findDcById(client, id);
    if (!dcPreview) throw new NotFoundError("Delivery Challan not found.");
    // IPO before DC — the documented chain lock order.
    await ipoRepo.lockIpoById(client, dcPreview.ipo_id);
    const dc = await repo.lockDcById(client, id);
    assertSupplyChainRecordVisible(actor, dc);

    if (dc.status !== DC_STATUS.DRAFT) {
      throw new ConflictError("Only a draft Delivery Challan can be edited.");
    }

    if (input.note !== undefined) {
      await repo.updateDcNote(client, id, input.note);
    }
    if (input.lines) {
      const lines = await resolveAllocatableLines(client, dc.ipo_id, input.lines, { excludeDcId: id });
      await repo.replaceDcLines(client, id, dc.ipo_id, lines);
    }

    await recordProcurementAudit(client, {
      ipoId: dc.ipo_id,
      entityType: ENTITY_TYPE,
      entityId: id,
      actorUserId: actor.id,
      action: "DC_UPDATED",
      previousStatus: DC_STATUS.DRAFT,
      newStatus: DC_STATUS.DRAFT,
    });
  });

  return getDcDetail(actor, id);
}

export async function finalizeDeliveryChallan(actor, id) {
  assertCanManage(actor);

  await withTransaction(async (client) => {
    const dcPreview = await repo.findDcById(client, id);
    if (!dcPreview) throw new NotFoundError("Delivery Challan not found.");
    await ipoRepo.lockIpoById(client, dcPreview.ipo_id);
    const dc = await repo.lockDcById(client, id);
    assertSupplyChainRecordVisible(actor, dc);

    // A replayed finalize is a successful no-op — one transition, one audit
    // row, one notification per recipient.
    if (dc.status === DC_STATUS.FINALIZED) return;
    if (dc.status !== DC_STATUS.DRAFT) {
      throw new ConflictError(`Cannot finalize a Delivery Challan currently in ${dc.status} state.`);
    }

    const lines = await repo.findDcLines(client, id);
    if (lines.length === 0) {
      throw new ValidationError("A Delivery Challan must have at least one line before it can be finalized.");
    }

    await repo.markFinalized(client, id, actor.id);
    await recordProcurementAudit(client, {
      ipoId: dc.ipo_id,
      entityType: ENTITY_TYPE,
      entityId: id,
      actorUserId: actor.id,
      action: "DC_FINALIZED",
      previousStatus: DC_STATUS.DRAFT,
      newStatus: DC_STATUS.FINALIZED,
      metadata: { dcNumber: dc.dc_number, lineCount: lines.length },
    });

    // Rendering + official WhatsApp sharing happen after this transaction
    // commits, as a durable retryable job: finalizing a Delivery Challan must
    // never fail, block or roll back because a renderer, object storage or an
    // external messaging API had a problem.
    await enqueue(client, [
      {
        channel: "SYSTEM",
        eventType: "GENERATE_DC_DOCUMENT",
        entityType: "DELIVERY_CHALLAN",
        entityId: id,
        recipientSiteId: dc.site_id,
        idempotencyKey: `generate-dc-document:${id}`,
        payload: { actorUserId: actor.id },
      },
    ]);

    // The owning department is told material is on its way. Routed to that
    // department's own receiving/confirming users at that site — never
    // broadcast to every capable user.
    const [receivers, confirmers] = await Promise.all([
      resolveEligibleRecipients({
        capabilityCode: "receiving.receive",
        siteId: dc.site_id,
        departmentId: dc.department_id,
      }),
      resolveEligibleRecipients({
        capabilityCode: "receiving.confirm",
        siteId: dc.site_id,
        departmentId: dc.department_id,
      }),
    ]);
    const recipients = new Set([...receivers, ...confirmers]);

    if (recipients.size > 0) {
      await enqueue(
        client,
        [...recipients].map((userId) => ({
          channel: "IN_APP",
          eventType: "DELIVERY_CHALLAN_FINALIZED",
          entityType: "DELIVERY_CHALLAN",
          entityId: id,
          recipientUserId: userId,
          recipientSiteId: dc.site_id,
          idempotencyKey: `dc:${id}:finalized:${userId}`,
          payload: {
            dcNumber: dc.dc_number,
            departmentId: dc.department_id,
            message: `Delivery Challan ${dc.dc_number} is ready for receiving.`,
            deepLink: `/receiving/${id}`,
          },
        })),
      );
    }
  });

  return getDcDetail(actor, id);
}

export async function cancelDeliveryChallan(actor, id, { reason }) {
  assertCanManage(actor);

  await withTransaction(async (client) => {
    const dcPreview = await repo.findDcById(client, id);
    if (!dcPreview) throw new NotFoundError("Delivery Challan not found.");
    await ipoRepo.lockIpoById(client, dcPreview.ipo_id);
    const dc = await repo.lockDcById(client, id);
    assertSupplyChainRecordVisible(actor, dc);

    if (dc.status === DC_STATUS.CANCELLED) {
      throw new ConflictError("This Delivery Challan is already cancelled.");
    }
    if (dc.status === DC_STATUS.COMPLETED) {
      throw new ConflictError("A completed Delivery Challan cannot be cancelled.");
    }
    // Cancel-and-replace is the correction path for a finalized challan, but
    // only while nothing has physically been received against it — receiving
    // history is never voided by a Procurement-side correction.
    if (await repo.hasAnyReceipt(client, id)) {
      throw new ConflictError(
        "Material has already been received against this Delivery Challan, so it can no longer be cancelled.",
      );
    }

    await repo.markCancelled(client, id, actor.id, reason);
    await recordProcurementAudit(client, {
      ipoId: dc.ipo_id,
      entityType: ENTITY_TYPE,
      entityId: id,
      actorUserId: actor.id,
      action: "DC_CANCELLED",
      previousStatus: dc.status,
      newStatus: DC_STATUS.CANCELLED,
      metadata: { dcNumber: dc.dc_number, reason },
    });
  });

  return getDcDetail(actor, id);
}

// Called by the receiving module once a receipt is confirmed. The caller
// already holds the IPO and DC row locks.
export async function evaluateDcCompletion(client, { dc, actorId }) {
  if (dc.status === DC_STATUS.COMPLETED || dc.status === DC_STATUS.CANCELLED) return false;

  const unresolved = await repo.countUnresolvedLines(client, dc.id);
  if (unresolved > 0) {
    if (dc.status !== DC_STATUS.RECEIVING) {
      await repo.updateDcStatus(client, dc.id, DC_STATUS.RECEIVING);
    }
    return false;
  }

  await repo.markCompleted(client, dc.id);
  await recordProcurementAudit(client, {
    ipoId: dc.ipo_id,
    entityType: ENTITY_TYPE,
    entityId: dc.id,
    actorUserId: actorId,
    action: "DC_COMPLETED",
    previousStatus: dc.status,
    newStatus: DC_STATUS.COMPLETED,
  });
  return true;
}

// Operational document, generated on demand from persisted DC data. Contains
// no approval history, no internal Procurement notes and no prices — the
// printed DC stays a clean operational document (spec §19 of the build
// prompt). Authorization is re-checked on every download.
export async function generatePdf(actor, id) {
  assertCanView(actor);
  const dc = await repo.findDcById(pool, id);
  if (!dc) throw new NotFoundError("Delivery Challan not found.");
  assertSupplyChainRecordVisible(actor, dc);

  const filename = documentFilename(dc.dc_number, "pdf");

  // The stored rendering is the document the department was actually sent —
  // serve that rather than re-rendering finalized history.
  const stored = await findStoredDocument(pool, ENTITY_TYPE, id);
  if (stored) {
    return { buffer: await storageService.read(stored.storage_key), filename };
  }

  const lines = await repo.findDcLines(pool, id);
  const buffer = await generateDeliveryChallanPdf({ deliveryChallan: dc, lines });
  return { buffer, filename };
}

// ---------------------------------------------------------------------------
// Document generation + official WhatsApp delivery (outbox job)
// ---------------------------------------------------------------------------

// Idempotent on retry via the stored-document row, exactly like the IPO job.
// The rendered bytes are kept so the challan that was actually shared with the
// department stays reproducible even if the template changes later.
async function processDcDocumentJob(item) {
  const dcId = item.entity_id;
  const outcome = { status: "SENT" };
  let newlyUploadedStorageKey = null;

  try {
    await withTransaction(async (client) => {
      // Locked for the same reason as the IPO document job: cancellation
      // locks this row too, so the two can never interleave into a shared
      // document for a cancelled challan.
      const locked = await repo.lockDcById(client, dcId);
      if (!locked) return;

      if (locked.status === DC_STATUS.CANCELLED) {
        outcome.status = "VOID";
        return;
      }

      const dc = await repo.findDcById(client, dcId);

      let stored = await findStoredDocument(client, ENTITY_TYPE, dcId);

      if (!stored) {
        const lines = await repo.findDcLines(client, dcId);
        const buffer = await generateDeliveryChallanPdf({ deliveryChallan: dc, lines });
        const saved = await saveDocumentBytes(buffer, { ownerId: dcId, category: "delivery-challan" });
        newlyUploadedStorageKey = saved.storageKey;

        stored = await insertStoredDocument(client, {
          ipoId: dc.ipo_id,
          entityType: ENTITY_TYPE,
          entityId: dcId,
          documentNumber: dc.dc_number,
          storageKey: saved.storageKey,
          sizeBytes: saved.sizeBytes,
          checksumSha256: saved.checksumSha256,
        });

        await recordProcurementAudit(client, {
          ipoId: dc.ipo_id,
          entityType: ENTITY_TYPE,
          entityId: dcId,
          actorUserId: item.payload.actorUserId,
          action: "DOCUMENT_GENERATED",
          metadata: { documentNumber: dc.dc_number },
        });
      }

      await queueWhatsAppDocument(client, {
        ipoId: dc.ipo_id,
        entityType: ENTITY_TYPE,
        entityId: dcId,
        eventType: "DELIVERY_CHALLAN_DOCUMENT",
        documentNumber: dc.dc_number,
        storageKey: stored.storage_key,
        // The department's own group, falling back to the configured default.
        destination: await resolveDepartmentDestination(client, dc.department_id),
        caption: `Delivery Challan ${dc.dc_number} — ${dc.department_name}`,
        siteId: dc.site_id,
        actorUserId: item.payload.actorUserId,
      });
    });

    newlyUploadedStorageKey = null;
  } catch (error) {
    if (newlyUploadedStorageKey) {
      await storageService.remove(newlyUploadedStorageKey);
    }
    throw error;
  }

  return outcome;
}

registerSystemJobHandler("GENERATE_DC_DOCUMENT", processDcDocumentJob);

registerEntityRecheckHandler("DELIVERY_CHALLAN", async (dcId) => {
  const dc = await repo.findDcById(pool, dcId);
  return Boolean(dc) && dc.status !== DC_STATUS.CANCELLED;
});
