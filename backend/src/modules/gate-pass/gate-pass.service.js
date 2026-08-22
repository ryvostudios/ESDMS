import crypto from "node:crypto";
import { withTransaction } from "../../shared/db/with-transaction.js";
import { storageService } from "../../shared/storage/storage-service.js";
import { enqueue } from "../../shared/notifications/outbox.repository.js";
import { registerSystemJobHandler } from "../../shared/notifications/outbox.processor.js";
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from "../../shared/errors/app-error.js";
import {
  isWithinGatePassScope,
  resolveCreateDepartmentId,
  assertDepartmentChangeAllowed,
  assertDepartmentUsable,
} from "./gate-pass.authorization.js";
import { TRANSITIONS, GATE_PASS_STATUS } from "./gate-pass.constants.js";
import { generateGatePassPdf } from "./gate-pass.pdf.js";
import * as repo from "./gate-pass.repository.js";
import config from "../../config/env.js";

function hashToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export async function getGatePassDetail(actor, id) {
  const gatePass = await repo.findById(id);

  if (!gatePass) {
    throw new NotFoundError("Gate Pass not found.");
  }

  if (!isWithinGatePassScope(actor, gatePass)) {
    // 404, not 403 — do not reveal that a record exists outside scope.
    throw new NotFoundError("Gate Pass not found.");
  }

  const [items, auditLog] = await Promise.all([
    repo.findItemsByGatePassId(id),
    repo.findAuditLogByGatePassId(id),
  ]);

  return { gatePass, items, auditLog };
}

export async function listGatePasses(actor, filters) {
  return repo.listForScope(actor, filters);
}

export async function createGatePass(actor, input) {
  // Resolved and validated *before* any row is written — a rejected
  // department never gets as far as an insert, so there is no ghost
  // cross-department row to clean up afterward.
  const departmentId = resolveCreateDepartmentId(actor, input.issuingDepartmentId);
  await assertDepartmentUsable(actor, departmentId);

  return withTransaction(async (client) => {
    const gatePassNumber = await repo.nextGatePassNumber(client);
    const id = await repo.insertDraft(client, gatePassNumber, actor.id, actor.siteId, departmentId, input);
    await repo.insertItems(client, id, input.items);
    await repo.insertAuditLog(client, {
      gatePassId: id,
      actorUserId: actor.id,
      action: "CREATE",
      newStatus: GATE_PASS_STATUS.DRAFT,
    });

    return id;
  });
}

export async function updateDraft(actor, id, input) {
  return withTransaction(async (client) => {
    const gatePass = await repo.lockById(client, id);

    if (!gatePass) {
      throw new NotFoundError("Gate Pass not found.");
    }

    if (!isWithinGatePassScope(actor, gatePass)) {
      throw new NotFoundError("Gate Pass not found.");
    }

    if (gatePass.status !== GATE_PASS_STATUS.DRAFT) {
      throw new ConflictError("Only a Gate Pass in DRAFT can be edited.");
    }

    if (input.issuingDepartmentId !== undefined) {
      // An explicit, visible denial — not a silent override — since the
      // actor is knowingly trying to change a field on a record that
      // already exists.
      assertDepartmentChangeAllowed(actor, input.issuingDepartmentId);
      await assertDepartmentUsable(actor, input.issuingDepartmentId);
    }

    await repo.updateDraftFields(client, id, input);

    if (input.items) {
      await repo.replaceItems(client, id, input.items);
    }

    await repo.insertAuditLog(client, {
      gatePassId: id,
      actorUserId: actor.id,
      action: "EDIT_DRAFT",
      previousStatus: GATE_PASS_STATUS.DRAFT,
      newStatus: GATE_PASS_STATUS.DRAFT,
    });
  });
}

async function runTransition(actor, id, transitionName, extra = {}) {
  const definition = TRANSITIONS[transitionName];

  if (!actor.permissions.has(definition.permission)) {
    throw new ForbiddenError();
  }

  const approvalToken = transitionName === "approve" ? crypto.randomBytes(32).toString("base64url") : null;

  await withTransaction(async (client) => {
    const gatePass = await repo.lockById(client, id);

    if (!gatePass) {
      throw new NotFoundError("Gate Pass not found.");
    }

    if (!isWithinGatePassScope(actor, gatePass)) {
      throw new NotFoundError("Gate Pass not found.");
    }

    if (!definition.from.includes(gatePass.status)) {
      throw new ConflictError(
        `Cannot ${transitionName} a Gate Pass currently in ${gatePass.status} state.`,
      );
    }

    if (transitionName === "approve") {
      await repo.markApproved(client, id, {
        approvedByUserId: actor.id,
        tokenHash: hashToken(approvalToken),
        status: definition.to,
      });
    } else if (transitionName === "reject") {
      await repo.markRejected(client, id, {
        rejectedByUserId: actor.id,
        reason: extra.reason,
        status: definition.to,
      });
    } else if (transitionName === "cancel") {
      await repo.markCancelled(client, id, {
        cancelledByUserId: actor.id,
        reason: extra.reason,
        status: definition.to,
      });
    } else {
      await repo.updateStatus(client, id, definition.to);
    }

    await repo.insertAuditLog(client, {
      gatePassId: id,
      actorUserId: actor.id,
      action: definition.action,
      previousStatus: gatePass.status,
      newStatus: definition.to,
      metadata: extra.reason ? { reason: extra.reason } : undefined,
    });

    if (transitionName === "approve") {
      await enqueue(client, [
        {
          channel: "IN_APP",
          eventType: "GATE_PASS_APPROVED",
          entityType: "GATE_PASS",
          entityId: id,
          recipientRole: "GATE_GUARD",
          payload: {
            gatePassNumber: gatePass.gate_pass_number,
            driverName: gatePass.driver_name,
            vehicleRegistration: gatePass.vehicle_registration,
            destination: gatePass.destination,
            purpose: gatePass.purpose,
            approvedAt: new Date().toISOString(),
          },
        },
        // PDF generation + WhatsApp delivery are real work (render, disk
        // I/O, an external API) that must never gate this transition or
        // its HTTP response on their success — enqueued here, in the same
        // transaction as the approval itself, so the job is exactly as
        // durable as the approval: if this commits, the job WILL
        // eventually run, even across a crash/restart before it does.
        // Approving never again fails or half-succeeds because a PDF
        // render or storage write downstream had a problem.
        {
          channel: "SYSTEM",
          eventType: "GENERATE_APPROVAL_PDF",
          entityType: "GATE_PASS",
          entityId: id,
          idempotencyKey: `generate-approval-pdf:${id}`,
          payload: {
            rawToken: approvalToken,
            approvedByUserId: actor.id,
          },
        },
      ]);
    }
  });

  if (transitionName === "approve") {
    // Returned to the calling service function (not the HTTP layer — the
    // controller never forwards this) so tests can exercise the real
    // guard-verification flow without needing a QR decoder. Production
    // API responses never include the raw token; only the PDF/QR does.
    return { verificationToken: approvalToken };
  }

  return {};
}

// Outbox job handler for GENERATE_APPROVAL_PDF (see runTransition above).
// Runs on a retryable worker, possibly more than once for the same job —
// idempotent by re-deriving its own "already done?" check from durable
// state (an existing APPROVED_PDF file row) rather than trusting anything
// about its own prior attempts.
async function processApprovalPdfJob(item) {
  const gatePassId = item.entity_id;

  await withTransaction(async (client) => {
    const gatePass = await repo.findById(gatePassId);

    if (!gatePass) {
      // Should be unreachable — gate_passes forbids DELETE — but never
      // silently retry forever against a target that can't exist.
      return;
    }

    // Re-derive "already done?" from durable state instead of trusting
    // anything about this job's own prior attempts — safe to run twice.
    const existing = await repo.findLatestPdfFile(gatePassId, client);
    let storageKey = existing?.storage_key;

    if (!storageKey) {
      const items = await repo.findItemsByGatePassId(gatePassId);
      // A URL fragment, not a path segment: the browser never sends it to
      // any server, so it never lands in access/proxy logs when the QR
      // code is scanned and opened. The frontend reads it client-side and
      // POSTs it to the backend once, in the request body.
      const verificationUrl = `${config.appPublicUrl}/guard/verify#${item.payload.rawToken}`;
      const pdfBuffer = await generateGatePassPdf(gatePass, items, verificationUrl);
      const version = await repo.nextPdfVersion(gatePassId);
      const saved = await storageService.save(pdfBuffer, { gatePassId, category: "pdf", extension: "pdf" });
      storageKey = saved.storageKey;

      try {
        await repo.insertFile(client, {
          gatePassId,
          fileType: "APPROVED_PDF",
          storageKey: saved.storageKey,
          mimeType: "application/pdf",
          sizeBytes: saved.sizeBytes,
          checksumSha256: saved.checksumSha256,
          version,
          createdByUserId: item.payload.approvedByUserId,
        });
      } catch (error) {
        await storageService.remove(saved.storageKey);
        throw error;
      }
    }

    // Idempotent via idempotency_key regardless of which branch above ran
    // — a retry after the PDF row already exists just re-issues this as a
    // guaranteed-safe no-op rather than needing its own "already sent?"
    // check.
    await enqueue(client, [
      {
        channel: "WHATSAPP",
        eventType: "GATE_PASS_APPROVED",
        entityType: "GATE_PASS",
        entityId: gatePassId,
        recipientPhone: gatePass.driver_phone,
        idempotencyKey: `whatsapp-approval:${gatePassId}`,
        payload: {
          storageKey,
          filename: `${gatePass.gate_pass_number}.pdf`,
          caption: `Gate Pass ${gatePass.gate_pass_number} approved.`,
        },
      },
    ]);
  });
}

registerSystemJobHandler("GENERATE_APPROVAL_PDF", processApprovalPdfJob);

export const submitGatePass = (actor, id) => runTransition(actor, id, "submit");
export const approveGatePass = (actor, id) => runTransition(actor, id, "approve");
export const rejectGatePass = (actor, id, reason) => runTransition(actor, id, "reject", { reason });
export const cancelGatePass = (actor, id, reason) => runTransition(actor, id, "cancel", { reason });

export async function getVerificationDetail(actor, rawToken) {
  const gatePass = await repo.findByVerificationTokenHash(hashToken(rawToken), actor.siteId);

  if (!gatePass) {
    throw new NotFoundError("Gate Pass not found for this verification code.");
  }

  let allowedAction = null;
  let reason = null;

  if (gatePass.status === GATE_PASS_STATUS.APPROVED) {
    allowedAction = "EXIT";
  } else if (gatePass.status === GATE_PASS_STATUS.VEHICLE_OUTSIDE) {
    allowedAction = "RETURN";
  } else {
    reason = `This Gate Pass is ${gatePass.status.replaceAll("_", " ").toLowerCase()} and cannot be actioned at the gate.`;
  }

  return { gatePass, allowedAction, reason };
}

export async function searchForGuard(actor, query) {
  return repo.searchForGuard(query, actor.siteId);
}

// Backs a direct refresh/deep-link of the guard exit/return action page —
// the frontend previously relied entirely on React Router navigation state,
// which is gone on reload. Same data-minimized shape as search/dashboard.
export async function getGuardGatePass(actor, id) {
  const gatePass = await repo.findByIdForGuard(id, actor.siteId);

  if (!gatePass) {
    throw new NotFoundError("Gate Pass not found.");
  }

  return gatePass;
}

export async function getGuardDashboard(actor) {
  return repo.guardDashboard(actor.id, actor.siteId);
}

export async function recordExit(actor, id, { odometer, photo }) {
  if (!actor.permissions.has("gate_pass.exit")) {
    throw new ForbiddenError();
  }

  if (!photo) {
    throw new ValidationError("A departure photo is required.");
  }

  // Every state-dependent check runs, under the row lock, before a single
  // byte is written to disk — a rejected transition never creates a file
  // nothing will ever reference. If the write to disk succeeds but the
  // transaction that was going to reference it doesn't, the compensating
  // remove() below cleans it up rather than leaking it.
  let storageKey;

  try {
    await withTransaction(async (client) => {
      const gatePass = await repo.lockById(client, id);

      if (!gatePass || gatePass.site_id !== actor.siteId) {
        throw new NotFoundError("Gate Pass not found.");
      }

      if (gatePass.status !== GATE_PASS_STATUS.APPROVED) {
        throw new ConflictError(
          `Cannot record exit for a Gate Pass currently in ${gatePass.status} state.`,
        );
      }

      const saved = await storageService.save(photo.buffer, {
        gatePassId: id,
        category: "departure",
        extension: photo.extension,
      });
      storageKey = saved.storageKey;

      const photoFileId = await repo.insertFile(client, {
        gatePassId: id,
        fileType: "DEPARTURE_PHOTO",
        storageKey: saved.storageKey,
        mimeType: photo.mimeType,
        sizeBytes: saved.sizeBytes,
        checksumSha256: saved.checksumSha256,
        version: 1,
        createdByUserId: actor.id,
      });

      await repo.markExited(client, id, { odometer, byUserId: actor.id, photoFileId });

      await repo.insertAuditLog(client, {
        gatePassId: id,
        actorUserId: actor.id,
        action: "EXIT",
        previousStatus: GATE_PASS_STATUS.APPROVED,
        newStatus: GATE_PASS_STATUS.VEHICLE_OUTSIDE,
        metadata: { odometer },
      });
    });
  } catch (error) {
    if (storageKey) {
      await storageService.remove(storageKey);
    }
    throw error;
  }
}

export async function recordReturn(actor, id, { odometer, photo, remarks }) {
  if (!actor.permissions.has("gate_pass.return")) {
    throw new ForbiddenError();
  }

  if (!photo) {
    throw new ValidationError("A return photo is required.");
  }

  // Same ordering as recordExit: validate under the row lock first, write
  // to disk only once the transition is known-good, and compensate with a
  // remove() if the transaction fails after the write anyway.
  let storageKey;

  try {
    await withTransaction(async (client) => {
      const gatePass = await repo.lockById(client, id);

      if (!gatePass || gatePass.site_id !== actor.siteId) {
        throw new NotFoundError("Gate Pass not found.");
      }

      if (gatePass.status !== GATE_PASS_STATUS.VEHICLE_OUTSIDE) {
        throw new ConflictError(
          `Cannot record return for a Gate Pass currently in ${gatePass.status} state.`,
        );
      }

      if (gatePass.departure_odometer !== null && odometer < gatePass.departure_odometer) {
        throw new ValidationError("Return odometer cannot be lower than departure odometer.");
      }

      const saved = await storageService.save(photo.buffer, {
        gatePassId: id,
        category: "return",
        extension: photo.extension,
      });
      storageKey = saved.storageKey;

      const photoFileId = await repo.insertFile(client, {
        gatePassId: id,
        fileType: "RETURN_PHOTO",
        storageKey: saved.storageKey,
        mimeType: photo.mimeType,
        sizeBytes: saved.sizeBytes,
        checksumSha256: saved.checksumSha256,
        version: 1,
        createdByUserId: actor.id,
      });

      await repo.markReturned(client, id, { odometer, byUserId: actor.id, photoFileId, remarks });

      await repo.insertAuditLog(client, {
        gatePassId: id,
        actorUserId: actor.id,
        action: "RETURN",
        previousStatus: GATE_PASS_STATUS.VEHICLE_OUTSIDE,
        newStatus: GATE_PASS_STATUS.COMPLETED,
        metadata: { odometer },
      });
    });
  } catch (error) {
    if (storageKey) {
      await storageService.remove(storageKey);
    }
    throw error;
  }
}

export async function getAuthorizedFile(actor, gatePassId, fileId) {
  const gatePass = await repo.findById(gatePassId);

  if (!gatePass || !isWithinGatePassScope(actor, gatePass)) {
    throw new NotFoundError("File not found.");
  }

  const file = await repo.findFileById(fileId);

  if (!file || file.gate_pass_id !== gatePassId) {
    throw new NotFoundError("File not found.");
  }

  const buffer = await storageService.read(file.storage_key);

  return { buffer, mimeType: file.mime_type };
}

export async function getLatestPdf(actor, gatePassId) {
  const gatePass = await repo.findById(gatePassId);

  if (!gatePass || !isWithinGatePassScope(actor, gatePass)) {
    throw new NotFoundError("Gate Pass not found.");
  }

  const file = await repo.findLatestPdfFile(gatePassId);

  if (!file) {
    throw new NotFoundError("No approved Gate Pass document is available yet.");
  }

  const buffer = await storageService.read(file.storage_key);

  return { buffer, mimeType: file.mime_type };
}
