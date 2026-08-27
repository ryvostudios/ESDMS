import pool from "../../config/database.js";
import { withTransaction } from "../../shared/db/with-transaction.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../shared/errors/app-error.js";
import { enqueue } from "../../shared/notifications/outbox.repository.js";
import { resolveEligibleRecipients } from "../../shared/notifications/recipient-resolver.js";
import { recordProcurementAudit } from "../../shared/audit/procurement-audit.repository.js";
import {
  assertOwnDepartmentRecord,
  assertSupplyChainRecordVisible,
  hasFallbackReceivingAuthority,
  isWithinActorSite,
  resolveSupplyChainScope,
} from "../../shared/authorization/supply-chain-scope.js";
import * as demandRepo from "../material-demand/material-demand.repository.js";
import * as ipoRepo from "../ipo/ipo.repository.js";
import { evaluateChainCompletion } from "../ipo/ipo.service.js";
import * as dcRepo from "../delivery-challan/delivery-challan.repository.js";
import { evaluateDcCompletion } from "../delivery-challan/delivery-challan.service.js";
import { DC_STATUS, RECEIVABLE_STATUSES } from "../delivery-challan/delivery-challan.constants.js";
import {
  RECEIPT_STATUS,
  RECEIPT_TYPE,
  RECEIVING_CONFIRM_PERMISSION,
  RECEIVING_FALLBACK_PERMISSION,
  RECEIVING_RECEIVE_PERMISSION,
  RECEIVING_VIEW_PERMISSION,
} from "./receiving.constants.js";
import * as repo from "./receiving.repository.js";

const ENTITY_TYPE = "MATERIAL_RECEIPT";

function assertCanView(actor) {
  if (!actor.permissions.has(RECEIVING_VIEW_PERMISSION)) {
    throw new ForbiddenError();
  }
}

// A delivery is reachable by the fallback custodian ONLY while it is a
// delivery they could actually act on: same site, and still open for
// receiving. That is the minimum information required to perform the fallback
// operation, and it expires the moment the delivery closes — it never becomes
// a general window onto another department's history.
function isFallbackActionable(actor, dc) {
  return (
    hasFallbackReceivingAuthority(actor) &&
    isWithinActorSite(actor, dc) &&
    RECEIVABLE_STATUSES.includes(dc.status)
  );
}

function assertDeliveryVisible(actor, dc) {
  if (isFallbackActionable(actor, dc)) return;
  assertSupplyChainRecordVisible(actor, dc);
}

// A receipt the actor personally recorded stays visible to them so they can
// follow the handover they are responsible for — even after the delivery
// closes, and even though they hold no scope over that department generally.
function assertReceiptVisible(actor, receipt) {
  if (receipt.received_by_user_id === actor.id || receipt.handover_to_user_id === actor.id) return;
  assertSupplyChainRecordVisible(actor, receipt);
}

async function departmentRecipients(capabilityCode, record) {
  return resolveEligibleRecipients({
    capabilityCode,
    siteId: record.site_id,
    departmentId: record.department_id,
  });
}

async function notify(client, rows) {
  if (rows.length > 0) await enqueue(client, rows);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function listScope(actor, requestedDepartmentId) {
  const scope = resolveSupplyChainScope(actor);
  if (requestedDepartmentId && scope.tier === "OWN" && requestedDepartmentId !== scope.departmentId) {
    throw new NotFoundError("Record not found.");
  }
  return { siteId: scope.siteId, departmentId: requestedDepartmentId || scope.departmentId, tier: scope.tier };
}

export async function listOpenDeliveries(actor, query) {
  assertCanView(actor);
  const scope = listScope(actor, query.departmentId);

  // The one queue a fallback custodian legitimately needs: deliveries at
  // their own site that are still open for receiving. It lists nothing
  // historical and nothing commercial.
  if (scope.tier === "OWN" && hasFallbackReceivingAuthority(actor) && !query.departmentId) {
    return repo.listOpenDeliveries({ siteId: actor.siteId, departmentId: null }, query);
  }

  if (scope.tier === "OWN" && !scope.departmentId) return { rows: [], total: 0 };
  return repo.listOpenDeliveries(scope, query);
}

export async function listReceipts(actor, query) {
  assertCanView(actor);
  const scope = listScope(actor, query.departmentId);

  // Receiving HISTORY is never widened by fallback authority. A fallback
  // custodian additionally sees the receipts they themselves recorded or took
  // handover of — never the department's history at large.
  //
  // That personal exception is what a real Admin needs: an Admin belongs to
  // the Admin DEPARTMENT, so their ordinary scope is Admin-department
  // receipts, and the WTG delivery they personally took custody of would
  // otherwise vanish from their own history the moment they recorded it. It
  // is added to their normal scope, not substituted for it.
  //
  // Suppressed when a department filter is requested, exactly as the open-
  // delivery queue above does: a filter must narrow a result, never carry the
  // exception into a department the actor has no scope over.
  if (scope.tier === "OWN") {
    const personalActorUserId =
      hasFallbackReceivingAuthority(actor) && !query.departmentId ? actor.id : null;

    if (!scope.departmentId && !personalActorUserId) return { rows: [], total: 0 };

    return repo.listReceipts(
      { siteId: actor.siteId, departmentId: scope.departmentId, personalActorUserId },
      query,
    );
  }

  return repo.listReceipts(scope, query);
}

// Everything a receiving screen needs in one call: the delivery, its
// outstanding line quantities, and what has already been recorded against it.
export async function getDeliveryForReceiving(actor, dcId) {
  assertCanView(actor);
  const dc = await dcRepo.findDcById(pool, dcId);
  if (!dc) throw new NotFoundError("Delivery Challan not found.");
  assertDeliveryVisible(actor, dc);

  const [lines, receipts] = await Promise.all([dcRepo.findDcLines(pool, dcId), repo.findReceiptsForDc(pool, dcId)]);
  return { deliveryChallan: dc, lines, receipts };
}

export async function getReceiptDetail(actor, id) {
  assertCanView(actor);
  const receipt = await repo.findReceiptById(pool, id);
  if (!receipt) throw new NotFoundError("Receipt not found.");
  assertReceiptVisible(actor, receipt);

  const lines = await repo.findReceiptLines(pool, id);
  return { receipt, lines };
}

// ---------------------------------------------------------------------------
// Recording a receipt
// ---------------------------------------------------------------------------

// Two distinct authorizations, deliberately never collapsed into one:
//
//   normal department receiving  — receiving.receive, and the delivery MUST
//     belong to the actor's own department at their own site. Knowing another
//     department's Delivery Challan id gains nothing.
//   Admin temporary custody      — receiving.fallback_receive, site-scoped and
//     cross-department by design, and recorded as ADMIN_FALLBACK so the
//     material is never treated as handed to the department yet.
function assertReceivingAuthorized(actor, dc, fallback) {
  if (fallback) {
    if (!actor.permissions.has(RECEIVING_FALLBACK_PERMISSION)) {
      throw new ForbiddenError("Temporary custody requires fallback receiving authority.");
    }
    // Site-bound and nothing more. This is the ONLY place fallback authority
    // crosses a department boundary, and it does so for one physical act on
    // one delivery — it grants no view of that department's other records.
    if (!isWithinActorSite(actor, dc)) {
      throw new NotFoundError("Record not found.");
    }
    return;
  }

  if (!actor.permissions.has(RECEIVING_RECEIVE_PERMISSION)) {
    throw new ForbiddenError();
  }
  assertOwnDepartmentRecord(actor, dc);
}

// numeric(12,2) returns "20.00"; a client sends an exact decimal string that
// may be "20". Both are far below the safe-integer limit at two decimal
// places, so this normalises without float arithmetic on a booked quantity.
const sameDecimal = (a, b) => Number(a).toFixed(2) === Number(b).toFixed(2);

// An operation id names one logical receipt. Finding one under the id only
// means a retry IS possible — it does not mean THIS request is that retry.
// Answering "record 30" with the receipt that recorded 20 reports a delivery
// that never arrived, and reports it as a success, so the 20 stays unnoticed
// until someone counts the yard.
//
// Compared: the Delivery Challan, the custody mode (a department receipt and
// temporary Admin custody are different physical facts), who physically took
// delivery, and the exact set of lines with each received quantity,
// discrepancy quantity and discrepancy type. Lines are matched by id, not by
// position, because the API does not give line order any meaning.
//
// Free text — the receipt note and per-line discrepancy note — is excluded:
// it changes nothing about what quantity or custody was booked, and
// conflicting on a reworded note would break a legitimate retry.
function assertSameReceiptOperation(existing, dcId, input) {
  // Deliberately generic: the actor may be authorised for the Delivery
  // Challan they asked about and not for the one that owns the id, so this
  // names no challan, department, site, receipt or quantity.
  const conflict = new ConflictError(
    "This operation identifier has already been used for another request.",
  );

  if (existing.dc_id !== dcId) throw conflict;
  if (existing.receipt_type !== (input.fallback ? RECEIPT_TYPE.ADMIN_FALLBACK : RECEIPT_TYPE.DEPARTMENT)) {
    throw conflict;
  }
  if ((existing.physical_receiver_employee_id || null) !== (input.physicalReceiverEmployeeId || null)) {
    throw conflict;
  }
  if (existing.lines.length !== input.lines.length) throw conflict;

  const byLine = new Map(existing.lines.map((line) => [line.dc_line_id, line]));
  for (const requested of input.lines) {
    const line = byLine.get(requested.dcLineId);
    if (!line) throw conflict;
    if (!sameDecimal(line.received_quantity, requested.receivedQuantity)) throw conflict;
    if (!sameDecimal(line.discrepancy_quantity, requested.discrepancyQuantity)) throw conflict;
    if ((line.discrepancy_type || null) !== (requested.discrepancyType || null)) throw conflict;
  }
}

export async function recordReceipt(actor, dcId, input) {
  const receiptId = await withTransaction(async (client) => {
    const dcPreview = await dcRepo.findDcById(client, dcId);
    if (!dcPreview) throw new NotFoundError("Delivery Challan not found.");

    // Chain lock order: IPO, then Delivery Challan, then the new receipt.
    await ipoRepo.lockIpoById(client, dcPreview.ipo_id);
    const dc = await dcRepo.lockDcById(client, dcId);
    assertReceivingAuthorized(actor, dc, input.fallback);

    // Replay of the same logical receipt: return the receipt that already
    // exists rather than booking the same physical delivery twice. Checked
    // under the Delivery Challan row lock, so two concurrent identical
    // requests serialize; the unique index on operation_id is the ultimate
    // guarantee. A genuinely separate partial receipt carries a different
    // operation id and proceeds normally.
    const replayed = await repo.findReceiptOperationByOperationId(client, input.operationId);
    if (replayed) {
      assertSameReceiptOperation(replayed, dcId, input);
      return replayed.id;
    }

    if (!RECEIVABLE_STATUSES.includes(dc.status)) {
      throw new ConflictError(`Material cannot be received against a Delivery Challan in ${dc.status} state.`);
    }

    const dcLines = await dcRepo.findDcLines(client, dcId);
    const dcLinesById = new Map(dcLines.map((line) => [line.id, line]));

    const lines = input.lines.map((requested) => {
      const dcLine = dcLinesById.get(requested.dcLineId);
      if (!dcLine) {
        throw new ValidationError("One or more lines do not belong to this Delivery Challan.");
      }

      // V1 rejects over-receipt outright. The database re-checks the same
      // invariant under a row lock on the DC line, so two concurrent
      // receivers of the same line cannot both slip past this.
      const total = Number(requested.receivedQuantity) + Number(requested.discrepancyQuantity);
      if (total > Number(dcLine.unresolved_quantity)) {
        throw new ValidationError(
          "Received and discrepancy quantities cannot exceed the unresolved Delivery Challan quantity for a line.",
        );
      }

      return {
        ...requested,
        item_name_snapshot: dcLine.item_name_snapshot,
        uom_code_snapshot: dcLine.uom_code_snapshot,
        uom_name_snapshot: dcLine.uom_name_snapshot,
        dc_quantity: dcLine.quantity,
      };
    });

    let physicalReceiverEmployeeId = null;
    if (input.physicalReceiverEmployeeId) {
      // The employee is recorded as the physical receiver, never as the
      // actor. Department linkage is deliberately not asserted: employment
      // assignment is effective-dated and a legitimately present receiver may
      // be on a temporary assignment — the site check is the meaningful one.
      const employee = await repo.findActiveEmployee(input.physicalReceiverEmployeeId, dc.site_id);
      if (!employee) {
        throw new ValidationError("The recorded physical receiver is not an active employee at this site.");
      }
      physicalReceiverEmployeeId = employee.id;
    }

    const hasDiscrepancy = lines.some((line) => Number(line.discrepancyQuantity) > 0);
    const receiptType = input.fallback ? RECEIPT_TYPE.ADMIN_FALLBACK : RECEIPT_TYPE.DEPARTMENT;
    const status = input.fallback ? RECEIPT_STATUS.AWAITING_HANDOVER : RECEIPT_STATUS.PENDING_CONFIRMATION;

    const receipt = await repo.insertReceipt(client, {
      dcId,
      ipoId: dc.ipo_id,
      departmentId: dc.department_id,
      siteId: dc.site_id,
      receiptType,
      status,
      actorId: actor.id,
      physicalReceiverEmployeeId,
      note: input.note,
      operationId: input.operationId,
    });
    await repo.insertReceiptLines(client, receipt.id, dcId, lines);

    if (hasDiscrepancy) {
      await client.query("UPDATE material_receipts SET has_discrepancy = true WHERE id = $1", [receipt.id]);
    }

    if (dc.status !== DC_STATUS.RECEIVING) {
      await dcRepo.updateDcStatus(client, dcId, DC_STATUS.RECEIVING);
    }

    await recordProcurementAudit(client, {
      ipoId: dc.ipo_id,
      entityType: ENTITY_TYPE,
      entityId: receipt.id,
      actorUserId: actor.id,
      action: input.fallback ? "ADMIN_CUSTODY_RECORDED" : "RECEIPT_RECORDED",
      newStatus: status,
      metadata: {
        dcId,
        dcNumber: dc.dc_number,
        receiptType,
        physicalReceiverEmployeeId,
        lineCount: lines.length,
      },
    });

    const [confirmers, receivers] = await Promise.all([
      departmentRecipients(RECEIVING_CONFIRM_PERMISSION, dc),
      input.fallback ? departmentRecipients(RECEIVING_RECEIVE_PERMISSION, dc) : Promise.resolve([]),
    ]);

    const baseNotification = {
      channel: "IN_APP",
      entityType: "MATERIAL_RECEIPT",
      entityId: receipt.id,
      recipientSiteId: dc.site_id,
    };

    if (input.fallback) {
      // Admin has taken temporary custody — the department needs to collect
      // it, and its confirming authority needs to know it is pending.
      const recipients = new Set([...confirmers, ...receivers]);
      await notify(
        client,
        [...recipients].map((userId) => ({
          ...baseNotification,
          eventType: "MATERIAL_RECEIVED_BY_ADMIN",
          recipientUserId: userId,
          idempotencyKey: `receipt:${receipt.id}:admin-custody:${userId}`,
          payload: {
            dcNumber: dc.dc_number,
            departmentId: dc.department_id,
            message: `Delivery Challan ${dc.dc_number} was received into temporary Admin custody and is awaiting department handover.`,
            deepLink: `/receiving/receipts/${receipt.id}`,
          },
        })),
      );
    } else {
      await notify(
        client,
        confirmers.map((userId) => ({
          ...baseNotification,
          eventType: "MATERIAL_RECEIVED",
          recipientUserId: userId,
          idempotencyKey: `receipt:${receipt.id}:received:${userId}`,
          payload: {
            dcNumber: dc.dc_number,
            departmentId: dc.department_id,
            message: `Delivery Challan ${dc.dc_number} has been received. Please confirm completion.`,
            deepLink: `/receiving/receipts/${receipt.id}`,
          },
        })),
      );
    }

    if (hasDiscrepancy) {
      await notifyDiscrepancy(client, { dc, receipt, confirmers, actorId: actor.id });
    }

    return receipt.id;
  });

  return getReceiptDetail(actor, receiptId);
}

// A discrepancy reaches the department's confirming authority, Procurement
// (who bought it) and site management (who may have to act on it) — and
// nobody else. Quantities travel in the payload; prices never do.
async function notifyDiscrepancy(client, { dc, receipt, confirmers, actorId }) {
  const [buyers, managers] = await Promise.all([
    resolveEligibleRecipients({ capabilityCode: "procurement.purchase", siteId: dc.site_id }),
    resolveEligibleRecipients({
      capabilityCode: "demand.review",
      allScopePermissionCode: "demand.all_departments",
      siteId: dc.site_id,
    }),
  ]);

  const recipients = new Set([...confirmers, ...buyers, ...managers]);
  await notify(
    client,
    [...recipients].map((userId) => ({
      channel: "IN_APP",
      eventType: "RECEIVING_DISCREPANCY",
      entityType: "MATERIAL_RECEIPT",
      entityId: receipt.id,
      recipientUserId: userId,
      recipientSiteId: dc.site_id,
      idempotencyKey: `receipt:${receipt.id}:discrepancy:${userId}`,
      payload: {
        dcNumber: dc.dc_number,
        departmentId: dc.department_id,
        message: `A discrepancy was recorded while receiving Delivery Challan ${dc.dc_number}.`,
        deepLink: `/receiving/receipts/${receipt.id}`,
      },
    })),
  );

  await recordProcurementAudit(client, {
    ipoId: dc.ipo_id,
    entityType: ENTITY_TYPE,
    entityId: receipt.id,
    actorUserId: actorId,
    action: "RECEIPT_DISCREPANCY",
    newStatus: receipt.status,
    metadata: { dcId: dc.id, dcNumber: dc.dc_number },
  });
}

// ---------------------------------------------------------------------------
// Admin handover
// ---------------------------------------------------------------------------

// The DEPARTMENT acknowledges the handover — Admin cannot declare on the
// department's behalf that the department took the material. The original
// Admin receiver, the receiving timestamp, the recipient and the handover
// timestamp are all preserved separately; nothing is overwritten.
export async function acknowledgeHandover(actor, receiptId) {
  if (!actor.permissions.has(RECEIVING_RECEIVE_PERMISSION)) {
    throw new ForbiddenError();
  }

  await withTransaction(async (client) => {
    const preview = await repo.findReceiptById(client, receiptId);
    if (!preview) throw new NotFoundError("Receipt not found.");
    await ipoRepo.lockIpoById(client, preview.ipo_id);
    await dcRepo.lockDcById(client, preview.dc_id);
    const receipt = await repo.lockReceiptById(client, receiptId);
    assertOwnDepartmentRecord(actor, receipt);

    if (receipt.receipt_type !== RECEIPT_TYPE.ADMIN_FALLBACK) {
      throw new ConflictError("Only a temporary Admin custody receipt requires a department handover.");
    }
    // A replayed acknowledgement is a successful no-op; the database also
    // refuses to rewrite a completed handover.
    if (receipt.status !== RECEIPT_STATUS.AWAITING_HANDOVER) return;

    await repo.markHandoverComplete(client, receiptId, actor.id);
    await recordProcurementAudit(client, {
      ipoId: receipt.ipo_id,
      entityType: ENTITY_TYPE,
      entityId: receiptId,
      actorUserId: actor.id,
      action: "HANDOVER_COMPLETED",
      previousStatus: RECEIPT_STATUS.AWAITING_HANDOVER,
      newStatus: RECEIPT_STATUS.PENDING_CONFIRMATION,
      metadata: { dcId: receipt.dc_id, originalReceiverUserId: receipt.received_by_user_id },
    });

    const confirmers = await departmentRecipients(RECEIVING_CONFIRM_PERMISSION, receipt);
    await notify(
      client,
      confirmers.map((userId) => ({
        channel: "IN_APP",
        eventType: "MATERIAL_HANDOVER_COMPLETED",
        entityType: "MATERIAL_RECEIPT",
        entityId: receiptId,
        recipientUserId: userId,
        recipientSiteId: receipt.site_id,
        idempotencyKey: `receipt:${receiptId}:handover:${userId}`,
        payload: {
          dcNumber: preview.dc_number,
          departmentId: receipt.department_id,
          message: `Temporary Admin custody of ${preview.dc_number} has been handed over to the department. Please confirm completion.`,
          deepLink: `/receiving/receipts/${receiptId}`,
        },
      })),
    );
  });

  return getReceiptDetail(actor, receiptId);
}

// ---------------------------------------------------------------------------
// Department confirmation and chain closure
// ---------------------------------------------------------------------------

export async function confirmReceipt(actor, receiptId) {
  if (!actor.permissions.has(RECEIVING_CONFIRM_PERMISSION)) {
    throw new ForbiddenError();
  }

  await withTransaction(async (client) => {
    const preview = await repo.findReceiptById(client, receiptId);
    if (!preview) throw new NotFoundError("Receipt not found.");

    // Full chain lock order: Demand, IPO, Delivery Challan, Receipt — because
    // confirming the last outstanding line can close all four.
    const ipoPreview = await ipoRepo.findIpoById(client, preview.ipo_id);
    const demand = await demandRepo.lockById(client, ipoPreview.demand_id);
    await ipoRepo.lockIpoById(client, preview.ipo_id);
    const dc = await dcRepo.lockDcById(client, preview.dc_id);
    const receipt = await repo.lockReceiptById(client, receiptId);
    assertOwnDepartmentRecord(actor, receipt);

    // A replayed confirmation is a successful no-op — never a second audit
    // row and never a second closure evaluation.
    if (receipt.status === RECEIPT_STATUS.COMPLETED) return;
    if (receipt.status !== RECEIPT_STATUS.PENDING_CONFIRMATION) {
      throw new ConflictError(
        "This receipt is awaiting department handover and cannot be confirmed yet.",
      );
    }

    await repo.markConfirmed(client, receiptId, actor.id);
    await recordProcurementAudit(client, {
      ipoId: receipt.ipo_id,
      entityType: ENTITY_TYPE,
      entityId: receiptId,
      actorUserId: actor.id,
      action: "RECEIPT_CONFIRMED",
      previousStatus: RECEIPT_STATUS.PENDING_CONFIRMATION,
      newStatus: RECEIPT_STATUS.COMPLETED,
      metadata: { dcId: receipt.dc_id },
    });

    // Closure is evaluated, never asserted: the Delivery Challan closes only
    // when every one of its lines is fully confirmed, and the IPO/Demand
    // close only when purchasing was explicitly closed and every purchased
    // quantity has been delivered and confirmed.
    const dcCompleted = await evaluateDcCompletion(client, { dc, actorId: actor.id });
    if (dcCompleted) {
      await evaluateChainCompletion(client, { ipoId: receipt.ipo_id, demand, actorId: actor.id });
    }
  });

  return getReceiptDetail(actor, receiptId);
}
