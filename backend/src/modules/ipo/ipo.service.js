import { withTransaction } from "../../shared/db/with-transaction.js";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors/app-error.js";
import { enqueue } from "../../shared/notifications/outbox.repository.js";
import { resolveEligibleRecipients } from "../../shared/notifications/recipient-resolver.js";
import { recordProcurementAudit, findAuditByIpoId } from "../../shared/audit/procurement-audit.repository.js";
import config from "../../config/env.js";
import { storageService } from "../../shared/storage/storage-service.js";
import {
  registerEntityRecheckHandler,
  registerSystemJobHandler,
} from "../../shared/notifications/outbox.processor.js";
import {
  findStoredDocument,
  insertStoredDocument,
  queueWhatsAppDocument,
  saveDocumentBytes,
} from "../../shared/documents/document-delivery.js";
import { documentFilename, nextDocumentNumber } from "../../shared/documents/document-number.js";
import { resolveSupplyChainScope, isAllScopeActor } from "../../shared/authorization/supply-chain-scope.js";
import pool from "../../config/database.js";
import { MATERIAL_DEMAND_STATUS } from "../material-demand/material-demand.constants.js";
import * as demandRepo from "../material-demand/material-demand.repository.js";
import {
  listAvailableCarryForward,
  releaseCarryForward,
} from "../material-demand/carry-forward.service.js";
import {
  assertCanDownloadIpoPdf,
  assertCanPurchase,
  assertCanViewIpo,
  assertIpoVisible,
  canSeeCommercialData,
} from "./ipo.authorization.js";
import { generateIpoPdf } from "./ipo.pdf.js";
import {
  ACTIVE_IPO_STATUSES,
  IPO_DOCUMENT_TYPE,
  IPO_STATUS,
  IPO_CANCEL_PERMISSION,
} from "./ipo.constants.js";
import * as repo from "./ipo.repository.js";

// Lock order for the entire purchasing chain, applied by every writer in this
// phase so two concurrent workflows can never deadlock:
//
//     Demand -> Pricing -> IPO -> Delivery Challan -> Material Receipt
//
// A writer that only needs part of the chain still takes the locks it does
// need in this order, and re-validates state AFTER acquiring them.

const ENTITY_TYPE = "IPO";

// A free-text cancellation reason routinely carries commercial context
// ("supplier raised the price from 10,000 to 18,000"). The CATEGORY is
// operational and stays visible so an operational viewer understands why work
// stopped; the free text is commercial and is withheld exactly like a price.
function redactCancellation(ipo, includeCommercial) {
  if (includeCommercial || !ipo.cancellation_reason) return ipo;
  return { ...ipo, cancellation_reason: null };
}

function auditQuantities(lines) {
  // Quantities and identifiers only — never prices or Procurement notes
  // (see procurement-audit.repository.js). A correction additionally names the
  // purchase it reverses, so the fact that history was corrected — and which
  // purchase it touched — is never hidden.
  return lines.map((line) => ({
    ipoLineId: line.ipoLineId,
    quantity: line.quantity,
    ...(line.reversesPurchaseEventId ? { reversesPurchaseEventId: line.reversesPurchaseEventId } : {}),
  }));
}

async function notifyProcurement(client, ipo, { eventType, keySuffix, payload }) {
  const buyers = await resolveEligibleRecipients({
    capabilityCode: "procurement.purchase",
    siteId: ipo.site_id,
    executor: client,
  });
  const pricers = await resolveEligibleRecipients({
    capabilityCode: "procurement.pricing",
    siteId: ipo.site_id,
    executor: client,
  });
  const recipients = new Set([...buyers, ...pricers]);
  if (recipients.size === 0) return;

  await enqueue(
    client,
    [...recipients].map((userId) => ({
      channel: "IN_APP",
      eventType,
      entityType: "IPO",
      entityId: ipo.id,
      recipientUserId: userId,
      recipientSiteId: ipo.site_id,
      idempotencyKey: `ipo:${ipo.id}:${keySuffix}:${userId}`,
      payload,
    })),
  );
}

// ---------------------------------------------------------------------------
// Generation — called from the final approval gate, inside its transaction.
// ---------------------------------------------------------------------------

// Exactly-once by construction: the unique (demand_id, demand_revision) index
// is the real guarantee, and this pre-check makes a replay a silent no-op
// rather than a constraint violation the caller has to interpret. Because it
// runs inside the caller's transaction under the Demand row lock, two
// concurrent final approvals cannot both reach the INSERT.
export async function generateIpoForApprovedDemand(client, { demand, pricing, dispositionFingerprint, actorId }) {
  const existing = await repo.findIpoByDemandRevision(client, demand.id, demand.revision);
  if (existing) return existing;

  const [lines, estimatedTotal] = await Promise.all([
    repo.findApprovedSnapshotLines(client, demand.id, pricing.id),
    repo.computeApprovedTotal(client, pricing.id),
  ]);

  if (lines.length === 0) {
    throw new ConflictError("The approved Pricing version has no priced lines to generate an IPO from.");
  }

  const ipoNumber = await nextDocumentNumber(client, IPO_DOCUMENT_TYPE);
  const ipo = await repo.insertIpo(client, {
    ipoNumber,
    demandId: demand.id,
    demandRevision: demand.revision,
    pricingId: pricing.id,
    // The fingerprint the caller's gate check just proved BOTH final
    // responsibilities approved — passed in from that same locked context
    // rather than recomputed here, so there is no window in which the two
    // could disagree.
    dispositionFingerprint,
    siteId: demand.site_id,
    departmentId: demand.department_id,
    currency: pricing.currency,
    estimatedTotal,
    actorId,
  });
  await repo.insertIpoLines(client, ipo.id, demand.id, lines);

  await recordProcurementAudit(client, {
    ipoId: ipo.id,
    entityType: ENTITY_TYPE,
    entityId: ipo.id,
    actorUserId: actorId,
    action: "IPO_GENERATED",
    newStatus: IPO_STATUS.GENERATED,
    metadata: {
      ipoNumber: ipo.ipo_number,
      demandId: demand.id,
      demandRevision: demand.revision,
      pricingId: pricing.id,
      pricingVersion: pricing.version,
      lineCount: lines.length,
    },
  });

  await demandRepo.updateStatus(client, demand.id, MATERIAL_DEMAND_STATUS.IPO_GENERATED);
  await demandRepo.insertAuditLog(client, {
    demandId: demand.id,
    actorUserId: actorId,
    action: "IPO_GENERATED",
    previousStatus: MATERIAL_DEMAND_STATUS.READY_FOR_IPO,
    newStatus: MATERIAL_DEMAND_STATUS.IPO_GENERATED,
    metadata: { ipoId: ipo.id, ipoNumber: ipo.ipo_number },
  });

  // Rendering the PDF, storing it and delivering it over WhatsApp are real
  // I/O against a renderer, object storage and an external API. None of them
  // may gate — or be able to undo — the approval that just happened, so they
  // are enqueued here as a durable SYSTEM job in this same transaction: if
  // the IPO commits, the job WILL eventually run, and if the job fails it
  // retries without ever touching the IPO.
  await enqueue(client, [
    {
      channel: "SYSTEM",
      eventType: "GENERATE_IPO_DOCUMENT",
      entityType: "IPO",
      entityId: ipo.id,
      recipientSiteId: ipo.site_id,
      idempotencyKey: `generate-ipo-document:${ipo.id}`,
      payload: { actorUserId: actorId },
    },
  ]);

  await notifyProcurement(client, ipo, {
    eventType: "IPO_GENERATED",
    keySuffix: "generated",
    payload: {
      ipoNumber: ipo.ipo_number,
      demandNumber: demand.demand_number,
      departmentId: demand.department_id,
      // No amounts in notification text — the recipient set is wider than
      // the price-view capability.
      message: `IPO ${ipo.ipo_number} has been generated for ${demand.department_name} Demand ${demand.demand_number}.`,
      deepLink: `/ipos/${ipo.id}`,
    },
  });

  return ipo;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listIpos(actor, query) {
  assertCanViewIpo(actor);
  const scope = resolveSupplyChainScope(actor);

  if (scope.tier === "OWN" && !scope.departmentId) {
    return { rows: [], total: 0 };
  }
  if (query.departmentId && scope.tier === "OWN" && query.departmentId !== scope.departmentId) {
    throw new NotFoundError("Record not found.");
  }

  return repo.listIpos(
    { siteId: scope.siteId, departmentId: query.departmentId || scope.departmentId },
    query,
  );
}

export async function getIpoDetail(actor, id) {
  assertCanViewIpo(actor);

  // Same bounded-footprint rule as getDemandDetail: these six reads run on
  // ONE checked-out client rather than fanning out across the pool, so a
  // single detail request can never consume five connections and starve
  // concurrent requests into a pool connect timeout.
  const client = await pool.connect();

  try {
    const ipo = await repo.findIpoById(client, id);
    if (!ipo) throw new NotFoundError("IPO not found.");
    assertIpoVisible(actor, ipo);

    const includeCommercial = canSeeCommercialData(actor);
    const lines = await repo.findIpoLines(client, id, { includeCommercial });
    const auditLog = await findAuditByIpoId(client, id);
    const chain = await repo.findChainForIpo(client, id);
    const commercials = includeCommercial ? await repo.findIpoCommercials(client, id) : null;
    const purchaseEvents = includeCommercial ? await repo.findPurchaseEvents(client, id) : [];

    // One call returns the whole traceable chain — IPO, its lines, its Delivery
    // Challans, every receipt and the ordered audit stream — so the history view
    // never has to stitch four endpoints together.
    return {
      ipo: redactCancellation(
        includeCommercial ? { ...ipo, estimated_total: commercials.estimated_total } : ipo,
        includeCommercial,
      ),
      lines,
      auditLog,
      // Every partial purchase, at the price actually paid, in order — so a
      // line bought twice at different prices reads as two real transactions
      // rather than one averaged fiction.
      purchaseEvents,
      deliveryChallans: chain.deliveryChallans,
      receipts: chain.receipts,
      includesCommercialData: includeCommercial,
    };
  } finally {
    client.release();
  }
}

// Previous Purchase Price for a set of physical items. Derived only from
// ACTUAL finalized purchasing history — never from an old estimate — and only
// for an actor who may see prices at all.
export async function getPreviousPurchasePrices(actor, companyItemIds) {
  if (!canSeeCommercialData(actor)) return new Map();
  return repo.findLatestActualPurchases(companyItemIds, isAllScopeActor(actor) ? null : actor.siteId);
}

// Unresolved prior requirements for the department, with what is still
// available after existing claims. Read-only: nothing here mutates the source
// IPO, the exclusion decision or the receipt it reports, and nothing is ever
// added to a Demand automatically — the department chooses.
export const listOutstandingCarryForward = listAvailableCarryForward;

// ---------------------------------------------------------------------------
// Workflow actions
// ---------------------------------------------------------------------------

export async function acknowledgeIpo(actor, id) {
  assertCanPurchase(actor);

  await withTransaction(async (client) => {
    const ipo = await repo.lockIpoById(client, id);
    if (!ipo) throw new NotFoundError("IPO not found.");
    assertIpoVisible(actor, ipo);

    // A replayed acknowledgement is a successful no-op, not a duplicate audit
    // row: acknowledgement is a fact about the IPO, not an event to count.
    if (ipo.status !== IPO_STATUS.GENERATED) {
      if (ACTIVE_IPO_STATUSES.includes(ipo.status)) return;
      throw new ConflictError(`Cannot acknowledge an IPO currently in ${ipo.status} state.`);
    }

    await repo.markAcknowledged(client, id, actor.id);
    await recordProcurementAudit(client, {
      ipoId: id,
      entityType: ENTITY_TYPE,
      entityId: id,
      actorUserId: actor.id,
      action: "IPO_ACKNOWLEDGED",
      previousStatus: IPO_STATUS.GENERATED,
      newStatus: IPO_STATUS.ACKNOWLEDGED,
    });
  });

  return getIpoDetail(actor, id);
}

// numeric(x,2) comes back from PostgreSQL as "20.00"; the client sends an exact
// decimal string that may be "20". Both are bounded far below the safe-integer
// limit at two decimal places, so this normalises without any float arithmetic
// on money.
const sameDecimal = (a, b) => Number(a).toFixed(2) === Number(b).toFixed(2);

// An operation id names one logical purchase operation. Finding events under it
// only means a retry IS possible — it does not mean this request is that retry.
// A request that differs in parent, shape or amounts is a client bug, and
// answering it with a success it did not earn would report a purchase that
// never happened: the caller sees 200, and the quantity it asked for is still
// unbought.
//
// Compared: the IPO, the exact set of lines, each quantity, each purchase
// price, and each event's reversal source — which is null for a purchase and
// set for a correction, so it also stops one id being used for both. A
// reversal's price is server-derived from the event it reverses (High Fix 2),
// so there is no client price to compare. Free-text notes are excluded: they
// change nothing about what was booked.
function assertSamePurchaseOperation(existing, ipoId, requestedLines) {
  // Deliberately generic. The actor may be authorised for the IPO they asked
  // about and not for the one that owns the id, so the conflict names no IPO,
  // line, quantity or price.
  const conflict = new ConflictError(
    "This operation identifier has already been used for another request.",
  );

  if (existing.length !== requestedLines.length) throw conflict;

  const byLine = new Map(existing.map((event) => [event.ipo_line_id, event]));
  for (const requested of requestedLines) {
    const event = byLine.get(requested.ipoLineId);
    if (!event) throw conflict;
    if (event.ipo_id !== ipoId) throw conflict;
    if (!sameDecimal(event.quantity, requested.quantity)) throw conflict;
    if ((event.reverses_purchase_event_id || null) !== (requested.reversesPurchaseEventId || null)) {
      throw conflict;
    }
    if (!requested.reversesPurchaseEventId && !sameDecimal(event.actual_unit_price, requested.actualUnitPrice)) {
      throw conflict;
    }
  }
}

export async function recordPurchase(actor, id, input) {
  assertCanPurchase(actor);

  await withTransaction(async (client) => {
    // Two requests sharing an operation id may target different IPOs, so no row
    // lock would serialize them. Taken first, before any row lock, so it is
    // always the outermost lock held here.
    await repo.acquirePurchaseOperationLock(client, input.operationId);

    const ipo = await repo.lockIpoById(client, id);
    if (!ipo) throw new NotFoundError("IPO not found.");
    assertIpoVisible(actor, ipo);

    // Replay of the same logical purchasing operation: a no-op. Nothing is
    // booked again, and — importantly — no second PURCHASE_RECORDED audit
    // event is written, because nothing actually happened. Authorization for
    // the requested IPO is already settled above, so a colliding id can reveal
    // nothing about the IPO that owns it.
    const replayed = await repo.findPurchaseEventsByOperationId(client, input.operationId);
    if (replayed.length > 0) {
      assertSamePurchaseOperation(replayed, id, input.lines);
      return;
    }

    if (ipo.status === IPO_STATUS.CANCELLED) {
      throw new ConflictError("Purchasing cannot be recorded against a cancelled IPO.");
    }
    if (ipo.status === IPO_STATUS.COMPLETED) {
      throw new ConflictError("This IPO is already completed.");
    }
    if (ipo.purchasing_closed_at) {
      throw new ConflictError("Purchasing has been closed for this IPO.");
    }

    const lines = await repo.lockIpoLines(client, id);
    const linesById = new Map(lines.map((line) => [line.id, line]));
    const allocated = await repo.allocatedQuantityByLine(client, id);

    for (const requested of input.lines) {
      const line = linesById.get(requested.ipoLineId);
      if (!line) {
        throw new ValidationError("One or more lines do not belong to this IPO.");
      }

      // A correction is not a fresh commercial decision: it withdraws part of
      // one specific earlier purchase, so its price is that purchase's price,
      // read from the event itself. The client never supplies it — which is
      // precisely what makes "reverse 60 bought at 100" impossible to record
      // as "-60 at 1" and leave 5,940 of value behind on an undone line.
      let actualUnitPrice = requested.actualUnitPrice;
      let procurementNote = requested.procurementNote || null;
      let reversesPurchaseEventId = null;

      if (requested.reversesPurchaseEventId) {
        const original = await repo.lockPurchaseEventForReversal(
          client,
          requested.reversesPurchaseEventId,
        );

        if (!original || original.ipo_id !== id || original.ipo_line_id !== requested.ipoLineId) {
          throw new ValidationError(
            "A correction must reference a purchase recorded against this IPO line.",
          );
        }
        if (original.reverses_purchase_event_id || Number(original.quantity) <= 0) {
          throw new ValidationError(
            "A correction may only reverse an original purchase, never another correction.",
          );
        }

        const stillReversible = Number(original.quantity) - Number(original.already_reversed);
        if (Math.abs(Number(requested.quantity)) > stillReversible) {
          throw new ConflictError(
            `Only ${stillReversible.toFixed(2)} of that purchase remains reversible.`,
          );
        }

        actualUnitPrice = original.actual_unit_price;
        procurementNote = requested.reason;
        reversesPurchaseEventId = original.id;
      }

      const resulting = Number(line.purchased_quantity) + Number(requested.quantity);

      // V1 rejects over-purchase outright — no exception policy exists yet.
      if (resulting > Number(line.approved_quantity)) {
        throw new ValidationError(
          "Purchased quantity cannot exceed the approved IPO quantity for a line.",
        );
      }
      if (resulting < 0) {
        throw new ValidationError("A correction cannot reduce a line below zero purchased quantity.");
      }

      // A correction cannot invalidate a delivery that already exists. Both
      // this path and Delivery Challan creation hold the same IPO row lock,
      // so the comparison cannot race.
      const alreadyAllocated = Number(allocated.get(requested.ipoLineId) || 0);
      if (resulting < alreadyAllocated) {
        throw new ConflictError(
          "Purchased quantity cannot be reduced below the quantity already placed on a Delivery Challan.",
        );
      }

      await repo.insertPurchaseEvent(client, {
        ipoId: id,
        ipoLineId: requested.ipoLineId,
        quantity: requested.quantity,
        actualUnitPrice,
        procurementNote,
        actorId: actor.id,
        operationId: input.operationId,
        reversesPurchaseEventId,
      });
      await repo.refreshPurchasedQuantity(client, requested.ipoLineId);
    }

    if (ipo.status !== IPO_STATUS.PURCHASING) {
      await repo.updateIpoStatus(client, id, IPO_STATUS.PURCHASING);
    }

    await recordProcurementAudit(client, {
      ipoId: id,
      entityType: ENTITY_TYPE,
      entityId: id,
      actorUserId: actor.id,
      action: "PURCHASE_RECORDED",
      previousStatus: ipo.status,
      newStatus: IPO_STATUS.PURCHASING,
      metadata: { operationId: input.operationId, lines: auditQuantities(input.lines) },
    });
  });

  return getIpoDetail(actor, id);
}

export async function closePurchasing(actor, id) {
  assertCanPurchase(actor);

  await withTransaction(async (client) => {
    // Closing purchasing can complete the whole chain, which updates the
    // Demand too — so the Demand row must be locked FIRST, in the documented
    // chain order. Reading the IPO unlocked here only discovers which Demand
    // that is; every decision below is made on the locked row.
    //
    // Taking the IPO lock first would invert the order used by receipt
    // confirmation (Demand -> IPO -> DC -> Receipt) and deadlock against a
    // Team Lead confirming the last receipt at the same moment.
    const preview = await repo.findIpoById(client, id);
    if (!preview) throw new NotFoundError("IPO not found.");
    const demand = await demandRepo.lockById(client, preview.demand_id);

    const ipo = await repo.lockIpoById(client, id);
    assertIpoVisible(actor, ipo);

    if (ipo.status === IPO_STATUS.CANCELLED) {
      throw new ConflictError("A cancelled IPO cannot be closed for purchasing.");
    }
    if (ipo.purchasing_closed_at) return;

    await repo.markPurchasingClosed(client, id, actor.id);
    await recordProcurementAudit(client, {
      ipoId: id,
      entityType: ENTITY_TYPE,
      entityId: id,
      actorUserId: actor.id,
      action: "PURCHASING_CLOSED",
      previousStatus: ipo.status,
      newStatus: ipo.status,
    });

    await evaluateChainCompletion(client, { ipoId: id, demand, actorId: actor.id });
  });

  return getIpoDetail(actor, id);
}

export async function cancelIpo(actor, id, { category, reason }) {
  if (!actor.permissions.has(IPO_CANCEL_PERMISSION)) {
    throw new NotFoundError("IPO not found.");
  }

  await withTransaction(async (client) => {
    // Demand first, then IPO — the documented chain lock order.
    const ipoPreview = await repo.findIpoById(client, id);
    if (!ipoPreview) throw new NotFoundError("IPO not found.");
    const demand = await demandRepo.lockById(client, ipoPreview.demand_id);
    const ipo = await repo.lockIpoById(client, id);
    assertIpoVisible(actor, ipo);

    if (ipo.status === IPO_STATUS.CANCELLED) {
      throw new ConflictError("This IPO is already cancelled.");
    }
    if (ipo.status === IPO_STATUS.COMPLETED) {
      throw new ConflictError("A completed IPO cannot be cancelled.");
    }

    // Conservative V1 policy, deliberately chosen while the business rule for
    // "cancel after purchasing began" is still unresolved: never silently
    // void recorded purchases or a live Delivery Challan. Cancellation is
    // available up to the point real money/material is committed; after that
    // the outstanding quantity is closed through purchasing closure instead.
    if (await repo.hasRecordedPurchases(client, id)) {
      throw new ConflictError(
        "This IPO already has recorded purchases. Close purchasing instead of cancelling, so recorded purchases are not voided.",
      );
    }
    if ((await repo.countOpenDeliveryChallans(client, id)) > 0) {
      throw new ConflictError("This IPO already has an active Delivery Challan and cannot be cancelled.");
    }

    await repo.markCancelled(client, id, actor.id, category || null, reason);
    await recordProcurementAudit(client, {
      ipoId: id,
      entityType: ENTITY_TYPE,
      entityId: id,
      actorUserId: actor.id,
      action: "IPO_CANCELLED",
      previousStatus: ipo.status,
      newStatus: IPO_STATUS.CANCELLED,
      // Category only. The audit stream is readable by everyone authorized to
      // see the record's history — a wider audience than price visibility —
      // so the potentially commercial free text stays out of it and lives
      // only on the protected IPO row.
      metadata: { category: category || null },
    });

    await demandRepo.updateStatus(client, ipo.demand_id, MATERIAL_DEMAND_STATUS.IPO_CANCELLED);
    // The purchasing this Demand represented will not happen, so any quantity
    // it claimed from an earlier shortfall returns to the pool.
    await releaseCarryForward(client, ipo.demand_id);
    await demandRepo.insertAuditLog(client, {
      demandId: ipo.demand_id,
      actorUserId: actor.id,
      action: "IPO_CANCELLED",
      previousStatus: demand.status,
      newStatus: MATERIAL_DEMAND_STATUS.IPO_CANCELLED,
      metadata: { ipoId: id, ipoNumber: ipo.ipo_number },
    });

    await notifyProcurement(client, ipo, {
      eventType: "IPO_CANCELLED",
      keySuffix: "cancelled",
      payload: {
        ipoNumber: ipo.ipo_number,
        departmentId: ipo.department_id,
        message: `IPO ${ipo.ipo_number} has been cancelled.`,
        deepLink: `/ipos/${id}`,
      },
    });

    const reviewers = await resolveEligibleRecipients({
      capabilityCode: "demand.review",
      allScopePermissionCode: "demand.all_departments",
      siteId: ipo.site_id,
      executor: client,
    });
    if (reviewers.length > 0) {
      await enqueue(
        client,
        reviewers.map((userId) => ({
          channel: "IN_APP",
          eventType: "IPO_CANCELLED",
          entityType: "IPO",
          entityId: id,
          recipientUserId: userId,
          recipientSiteId: ipo.site_id,
          idempotencyKey: `ipo:${id}:cancelled-management:${userId}`,
          payload: {
            ipoNumber: ipo.ipo_number,
            departmentId: ipo.department_id,
            message: `IPO ${ipo.ipo_number} has been cancelled.`,
            deepLink: `/ipos/${id}`,
          },
        })),
      );
    }
  });

  return getIpoDetail(actor, id);
}

// ---------------------------------------------------------------------------
// Chain closure
// ---------------------------------------------------------------------------

// The purchasing/receiving chain closes only when every quantity is resolved,
// never because someone pressed a button (spec §23, §30):
//   - Procurement has explicitly closed purchasing, so any approved-but-
//     unpurchased quantity is deliberate, traceable carry-forward;
//   - every purchased quantity has been placed on a Delivery Challan;
//   - every Delivery Challan is COMPLETED (fully received and department-
//     confirmed) or CANCELLED.
// Requested / Approved / Purchased / Delivered / Received / Outstanding /
// Discrepant all remain separately readable afterwards.
//
// The caller must already hold the Demand and IPO row locks.
export async function evaluateChainCompletion(client, { ipoId, demand, actorId }) {
  const ipo = await repo.lockIpoById(client, ipoId);
  if (!ipo || ipo.status === IPO_STATUS.CANCELLED || ipo.status === IPO_STATUS.COMPLETED) return false;
  if (!ipo.purchasing_closed_at) return false;

  const blockers = await repo.findCompletionBlockers(client, ipoId);
  if (blockers.unallocated > 0 || blockers.open_challans > 0) return false;

  await repo.markCompleted(client, ipoId);
  await recordProcurementAudit(client, {
    ipoId,
    entityType: ENTITY_TYPE,
    entityId: ipoId,
    actorUserId: actorId,
    action: "IPO_COMPLETED",
    previousStatus: ipo.status,
    newStatus: IPO_STATUS.COMPLETED,
  });

  if (demand && demand.status !== MATERIAL_DEMAND_STATUS.COMPLETED) {
    await demandRepo.updateStatus(client, demand.id, MATERIAL_DEMAND_STATUS.COMPLETED);
    await demandRepo.insertAuditLog(client, {
      demandId: demand.id,
      actorUserId: actorId,
      action: "COMPLETED",
      previousStatus: demand.status,
      newStatus: MATERIAL_DEMAND_STATUS.COMPLETED,
      metadata: { ipoId, ipoNumber: ipo.ipo_number },
    });

    // "Completed" means the digital Demand -> Procurement -> Receiving
    // workflow is finished. It does NOT mean the material was consumed, nor
    // that ESDMS knows any current stock level (spec §24).
    await enqueue(client, [
      {
        channel: "IN_APP",
        eventType: "DEMAND_WORKFLOW_COMPLETED",
        entityType: "MATERIAL_DEMAND",
        entityId: demand.id,
        recipientUserId: demand.created_by_user_id,
        recipientSiteId: ipo.site_id,
        idempotencyKey: `ipo:${ipoId}:workflow-completed:${demand.created_by_user_id}`,
        payload: {
          demandNumber: demand.demand_number,
          ipoNumber: ipo.ipo_number,
          message: `Demand ${demand.demand_number} has completed its procurement and receiving workflow.`,
          deepLink: `/demands/${demand.id}`,
        },
      },
    ]);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

// Generated on demand from authoritative persisted data — never from
// client-supplied content, and never served from a guessable static path.
// Authorization is re-checked here on every single download, so an
// unauthorized caller holding a valid IPO id gains nothing.
export async function generatePdf(actor, id) {
  assertCanDownloadIpoPdf(actor);

  const ipo = await repo.findIpoById(pool, id);
  if (!ipo) throw new NotFoundError("IPO not found.");
  assertIpoVisible(actor, ipo);

  const filename = documentFilename(ipo.ipo_number, "pdf");

  // Prefer the stored rendering: it is the exact document that was issued and
  // shared, so a later template change or master-data rename cannot restate
  // what an already-issued IPO said (spec §37/§42). Falling back to rendering
  // on demand keeps the download working in the window before the generation
  // job has run.
  const stored = await findStoredDocument(pool, ENTITY_TYPE, id);
  if (stored) {
    return { buffer: await storageService.read(stored.storage_key), filename };
  }

  const [lines, commercials, approvals] = await Promise.all([
    repo.findIpoLines(pool, id, { includeCommercial: true }),
    repo.findIpoCommercials(pool, id),
    repo.findIpoSignoffs(pool, id),
  ]);

  const buffer = await generateIpoPdf({
    ipo: { ...ipo, estimated_total: commercials.estimated_total },
    lines,
    approvals,
  });

  return { buffer, filename };
}

// ---------------------------------------------------------------------------
// Document generation + official WhatsApp delivery (outbox job)
// ---------------------------------------------------------------------------

// Runs on a retryable worker, possibly more than once for the same job.
// Idempotent by re-deriving "already done?" from durable state (an existing
// procurement_documents row) rather than trusting anything about its own
// prior attempts. Returns the status the processor should record.
async function processIpoDocumentJob(item) {
  const ipoId = item.entity_id;
  const outcome = { status: "SENT" };
  let newlyUploadedStorageKey = null;

  try {
    await withTransaction(async (client) => {
      // outbox.processor's stillDeliverable gate already re-checked
      // "cancelled?" once, but that read is unlocked and happens before this
      // transaction starts, so it can go stale. Taking the row lock closes
      // the window for real rather than narrowing it: cancellation locks the
      // same row, so whichever transaction wins the lock fully determines
      // the outcome, and nothing is ever generated for a cancelled IPO.
      const locked = await repo.lockIpoById(client, ipoId);
      if (!locked) return;

      if (locked.status === IPO_STATUS.CANCELLED) {
        // Cancellation won the race — there is nothing to share.
        outcome.status = "VOID";
        return;
      }

      const ipo = await repo.findIpoById(client, ipoId);

      let stored = await findStoredDocument(client, ENTITY_TYPE, ipoId);

      if (!stored) {
        const [lines, commercials, approvals] = await Promise.all([
          repo.findIpoLines(client, ipoId, { includeCommercial: true }),
          repo.findIpoCommercials(client, ipoId),
          repo.findIpoSignoffs(client, ipoId),
        ]);
        const buffer = await generateIpoPdf({
          ipo: { ...ipo, estimated_total: commercials.estimated_total },
          lines,
          approvals,
        });
        const saved = await saveDocumentBytes(buffer, { ownerId: ipoId, category: "ipo" });
        newlyUploadedStorageKey = saved.storageKey;

        stored = await insertStoredDocument(client, {
          ipoId,
          entityType: ENTITY_TYPE,
          entityId: ipoId,
          documentNumber: ipo.ipo_number,
          storageKey: saved.storageKey,
          sizeBytes: saved.sizeBytes,
          checksumSha256: saved.checksumSha256,
        });

        await recordProcurementAudit(client, {
          ipoId,
          entityType: ENTITY_TYPE,
          entityId: ipoId,
          actorUserId: item.payload.actorUserId,
          action: "DOCUMENT_GENERATED",
          metadata: { documentNumber: ipo.ipo_number },
        });
      }

      await queueWhatsAppDocument(client, {
        ipoId,
        entityType: ENTITY_TYPE,
        entityId: ipoId,
        eventType: "IPO_DOCUMENT",
        documentNumber: ipo.ipo_number,
        storageKey: stored.storage_key,
        destination: config.whatsapp.ipoDestination,
        // No amounts in the caption — a WhatsApp caption is visible in a
        // notification preview, which is a far wider surface than the
        // document's own authorization.
        caption: `Internal Purchase Order ${ipo.ipo_number}`,
        siteId: ipo.site_id,
        actorUserId: item.payload.actorUserId,
      });
    });

    newlyUploadedStorageKey = null;
  } catch (error) {
    if (newlyUploadedStorageKey) {
      // The bytes landed but the transaction that was going to reference them
      // did not survive. Remove the now-unreferenced object rather than
      // orphaning it. storageService.remove never throws.
      await storageService.remove(newlyUploadedStorageKey);
    }
    throw error;
  }

  return outcome;
}

registerSystemJobHandler("GENERATE_IPO_DOCUMENT", processIpoDocumentJob);

// Last-moment guard before ANY queued job for an IPO is delivered: a document
// for an IPO cancelled after its job was queued is never shared.
registerEntityRecheckHandler("IPO", async (ipoId) => {
  const ipo = await repo.findIpoById(pool, ipoId);
  return Boolean(ipo) && ipo.status !== IPO_STATUS.CANCELLED;
});
