import crypto from "node:crypto";
import { withTransaction } from "../../shared/db/with-transaction.js";
import { storageService } from "../../shared/storage/storage-service.js";
import { enqueue } from "../../shared/notifications/outbox.repository.js";
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from "../../shared/errors/app-error.js";
import { isWithinGatePassScope } from "./gate-pass.authorization.js";
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
  return withTransaction(async (client) => {
    const gatePassNumber = await repo.nextGatePassNumber(client);
    const id = await repo.insertDraft(client, gatePassNumber, actor.id, input);
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
      ]);
    }
  });

  if (transitionName === "approve") {
    await finalizeApproval(actor, id, approvalToken);
    // Returned to the calling service function (not the HTTP layer — the
    // controller never forwards this) so tests can exercise the real
    // guard-verification flow without needing a QR decoder. Production
    // API responses never include the raw token; only the PDF/QR does.
    return { verificationToken: approvalToken };
  }

  return {};
}

// PDF generation + WhatsApp outbox row happen after commit so external
// work (or a slow PDF render) never holds the row lock or blocks the
// approval transaction itself.
async function finalizeApproval(actor, id, rawToken) {
  const [gatePass, items] = await Promise.all([repo.findById(id), repo.findItemsByGatePassId(id)]);
  const verificationUrl = `${config.appPublicUrl}/guard/verify/${rawToken}`;

  const pdfBuffer = await generateGatePassPdf(gatePass, items, verificationUrl);
  const version = await repo.nextPdfVersion(id);

  const { storageKey, checksumSha256, sizeBytes } = await storageService.save(pdfBuffer, {
    gatePassId: id,
    category: "pdf",
    extension: "pdf",
  });

  await withTransaction(async (client) => {
    await repo.insertFile(client, {
      gatePassId: id,
      fileType: "APPROVED_PDF",
      storageKey,
      mimeType: "application/pdf",
      sizeBytes,
      checksumSha256,
      version,
      createdByUserId: actor.id,
    });

    await enqueue(client, [
      {
        channel: "WHATSAPP",
        eventType: "GATE_PASS_APPROVED",
        entityType: "GATE_PASS",
        entityId: id,
        recipientPhone: gatePass.driver_phone,
        payload: {
          storageKey,
          filename: `${gatePass.gate_pass_number}.pdf`,
          caption: `Gate Pass ${gatePass.gate_pass_number} approved.`,
        },
      },
    ]);
  });
}

export const submitGatePass = (actor, id) => runTransition(actor, id, "submit");
export const approveGatePass = (actor, id) => runTransition(actor, id, "approve");
export const rejectGatePass = (actor, id, reason) => runTransition(actor, id, "reject", { reason });
export const cancelGatePass = (actor, id, reason) => runTransition(actor, id, "cancel", { reason });

export async function getVerificationDetail(rawToken) {
  const gatePass = await repo.findByVerificationTokenHash(hashToken(rawToken));

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

export async function searchForGuard(query) {
  return repo.searchForGuard(query);
}

export async function getGuardDashboard(actor) {
  return repo.guardDashboard(actor.id);
}

export async function recordExit(actor, id, { odometer, photo }) {
  if (!actor.permissions.has("gate_pass.exit")) {
    throw new ForbiddenError();
  }

  if (!photo) {
    throw new ValidationError("A departure photo is required.");
  }

  const { storageKey, checksumSha256, sizeBytes } = await storageService.save(photo.buffer, {
    gatePassId: id,
    category: "departure",
    extension: photo.extension,
  });

  await withTransaction(async (client) => {
    const gatePass = await repo.lockById(client, id);

    if (!gatePass) {
      throw new NotFoundError("Gate Pass not found.");
    }

    if (gatePass.status !== GATE_PASS_STATUS.APPROVED) {
      throw new ConflictError(
        `Cannot record exit for a Gate Pass currently in ${gatePass.status} state.`,
      );
    }

    const photoFileId = await repo.insertFile(client, {
      gatePassId: id,
      fileType: "DEPARTURE_PHOTO",
      storageKey,
      mimeType: photo.mimeType,
      sizeBytes,
      checksumSha256,
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
}

export async function recordReturn(actor, id, { odometer, photo, remarks }) {
  if (!actor.permissions.has("gate_pass.return")) {
    throw new ForbiddenError();
  }

  if (!photo) {
    throw new ValidationError("A return photo is required.");
  }

  const { storageKey, checksumSha256, sizeBytes } = await storageService.save(photo.buffer, {
    gatePassId: id,
    category: "return",
    extension: photo.extension,
  });

  await withTransaction(async (client) => {
    const gatePass = await repo.lockById(client, id);

    if (!gatePass) {
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

    const photoFileId = await repo.insertFile(client, {
      gatePassId: id,
      fileType: "RETURN_PHOTO",
      storageKey,
      mimeType: photo.mimeType,
      sizeBytes,
      checksumSha256,
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
