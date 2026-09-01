import crypto from "node:crypto";
import { withTransaction } from "../../shared/db/with-transaction.js";
import { storageService } from "../../shared/storage/storage-service.js";
import { enqueue, voidPending } from "../../shared/notifications/outbox.repository.js";
import { registerSystemJobHandler, registerEntityRecheckHandler } from "../../shared/notifications/outbox.processor.js";
import { NotFoundError, ForbiddenError, ConflictError, ValidationError, ServiceUnavailableError } from "../../shared/errors/app-error.js";
import {
  isWithinGatePassScope,
  resolveCreateDepartmentId,
  assertDepartmentChangeAllowed,
  assertDepartmentUsable,
} from "./gate-pass.authorization.js";
import {
  TRANSITIONS,
  GATE_PASS_STATUS,
  EVIDENCE_KIND,
  EVIDENCE_FILE_TYPE,
  MAX_EVIDENCE_PHOTOS_PER_GATE_PASS,
} from "./gate-pass.constants.js";
import { generateGatePassPdf } from "./gate-pass.pdf.js";
import { generateGatePassCompletionPdf } from "./gate-pass.completion-pdf.js";
import * as repo from "./gate-pass.repository.js";
import { resolveDriverForGatePass, resolveVehicleForGatePass } from "../fleet/fleet.service.js";
import { logServerError } from "../../shared/logging/safe-logger.js";
import config from "../../config/env.js";

// Turns a Driver/Vehicle master selection into the immutable text the Gate
// Pass itself stores.
//
// This is the whole point of keeping driver_name / driver_phone /
// vehicle_registration as columns on gate_passes: the master row is
// provenance ("which record was picked"), the copied text is history. A
// Driver later renamed, or a Vehicle re-registered, therefore cannot rewrite
// what an already-issued Gate Pass says went out of the gate.
async function applyFleetSelection(actor, input) {
  if (!input.driverId && !input.vehicleId) return input;

  const resolved = { ...input };

  if (input.driverId) {
    const driver = await resolveDriverForGatePass(actor, input.driverId);
    resolved.driverName = driver.name;
    resolved.driverPhone = driver.phone;
  }

  if (input.vehicleId) {
    const vehicle = await resolveVehicleForGatePass(actor, input.vehicleId);
    resolved.vehicleRegistration = vehicle.registration_number;
  }

  return resolved;
}

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

  const [items, auditLog, pdfFile] = await Promise.all([
    repo.findItemsByGatePassId(id),
    repo.findAuditLogByGatePassId(id),
    // Cheap regardless of status — a row that was never approved simply
    // has none. This is the Fix #1 (demo blocker) readiness signal: the
    // frontend must never enable "View PDF" purely because status is
    // APPROVED, since the durable background job (see
    // processApprovalPdfJob) may not have run yet.
    repo.findLatestPdfFile(id),
  ]);

  return { gatePass, items, auditLog, documentReady: Boolean(pdfFile) };
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
  const resolved = await applyFleetSelection(actor, input);

  return withTransaction(async (client) => {
    const gatePassNumber = await repo.nextGatePassNumber(client);
    const id = await repo.insertDraft(client, gatePassNumber, actor.id, actor.siteId, departmentId, resolved);
    await repo.insertItems(client, id, resolved.items);
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

    await repo.updateDraftFields(client, id, await applyFleetSelection(actor, input));

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
      // Defense-in-depth layer 1 (see outbox.repository.js voidPending):
      // an approval that hasn't finished generating its PDF/WhatsApp
      // delivery yet must never produce either after the pass is
      // cancelled — a driver must never receive an "approved" document
      // for a trip that's already off.
      await voidPending(client, "GATE_PASS", id);
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
          recipientSiteId: gatePass.site_id,
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
          recipientSiteId: gatePass.site_id,
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
// about its own prior attempts. Returns the status the processor should
// record for this outbox row (see outbox.processor.js).
async function processApprovalPdfJob(item) {
  const gatePassId = item.entity_id;
  const outcome = { status: "SENT" };

  // Tracked outside the transaction, not just around insertFile: the
  // upload itself is not transactional (object storage has no concept of
  // this DB transaction), so a failure ANYWHERE from here through COMMIT
  // — insertFile, enqueue, or the COMMIT statement itself, which only
  // runs after this callback already returned (see withTransaction) —
  // must still trigger cleanup. Only set when THIS attempt uploaded a new
  // object; an already-existing, already-committed PDF found via
  // findLatestPdfFile below is never touched.
  let newlyUploadedStorageKey = null;

  try {
    // outbox.processor.js's stillDeliverable gate already re-checked
    // "cancelled?" once, generically, before this handler was ever
    // called — but that read isn't locked and happens before this
    // transaction starts, so it can go stale: a cancellation can still
    // land in the window between that check and this handler's own
    // commit. The row lock below closes that window for real, rather
    // than just narrowing it — see lockDetailById and runTransition's
    // cancel branch (which locks the same row). Whichever of the two
    // transactions acquires the lock first fully determines the outcome;
    // generate/upload/commit all happen while this transaction holds the
    // lock, so cancellation cannot interleave with it, and there is no
    // uploaded-but-orphaned PDF to clean up from THAT race specifically —
    // if cancellation wins the lock, this handler exits before ever
    // generating or uploading anything. (A plain DB failure at commit
    // time is a separate, unrelated risk — see the catch below.)
    await withTransaction(async (client) => {
      const gatePass = await repo.lockDetailById(client, gatePassId);

      if (!gatePass) {
        // Should be unreachable — gate_passes forbids DELETE — but never
        // silently retry forever against a target that can't exist.
        return;
      }

      if (gatePass.status === GATE_PASS_STATUS.CANCELLED) {
        // Cancellation won the race for this row's lock — nothing to
        // generate or deliver. The WHATSAPP follow-up job never gets
        // enqueued in this run, so there's nothing further for the generic
        // entity-recheck layer to catch.
        outcome.status = "VOID";
        return;
      }

      // Re-derive "already done?" from durable state instead of trusting
      // anything about this job's own prior attempts — safe to run twice.
      const existing = await repo.findLatestPdfFile(gatePassId, client);
      let storageKey = existing?.storage_key;

      if (!storageKey) {
        const items = await repo.findItemsByGatePassId(gatePassId);
        // URL-aware construction (not string concatenation) so this can
        // never produce a doubled path separator regardless of how
        // APP_PUBLIC_URL happens to be configured — config.appPublicUrl is
        // already canonicalized to a bare origin (see config/env.js), but
        // building the path this way is correct independent of that too.
        // The token is a URL fragment, not a path segment: the browser
        // never sends it to any server, so it never lands in access/proxy
        // logs when the QR code is scanned and opened. The frontend reads
        // it client-side and POSTs it to the backend once, in the request
        // body.
        const verificationUrlObject = new URL("/guard/verify", config.appPublicUrl);
        verificationUrlObject.hash = item.payload.rawToken;
        const verificationUrl = verificationUrlObject.toString();
        const pdfBuffer = await generateGatePassPdf(gatePass, items, verificationUrl);
        const version = await repo.nextPdfVersion(gatePassId);
        const saved = await storageService.save(pdfBuffer, { gatePassId, category: "pdf", extension: "pdf" });
        storageKey = saved.storageKey;
        newlyUploadedStorageKey = saved.storageKey;

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
          recipientSiteId: gatePass.site_id,
          idempotencyKey: `whatsapp-approval:${gatePassId}`,
          payload: {
            storageKey,
            filename: `${gatePass.gate_pass_number}.pdf`,
            caption: `Gate Pass ${gatePass.gate_pass_number} approved.`,
          },
        },
      ]);

      // Raw token minimization (Fix #11): the QR/PDF has now been generated
      // from it — nothing further ever needs the plaintext value again, so
      // it's erased from this job's own row rather than retained
      // indefinitely. (No-op if a prior, already-committed attempt already
      // did this — see the storageKey branch above.)
      await client.query(`UPDATE notification_outbox SET payload = payload - 'rawToken' WHERE id = $1`, [
        item.id,
      ]);
    });

    // Transaction committed successfully — any newly uploaded object is
    // now referenced by a committed row. Nothing to clean up.
    newlyUploadedStorageKey = null;
  } catch (error) {
    if (newlyUploadedStorageKey) {
      // The object was uploaded, but the transaction that was going to
      // reference it — whether insertFile/enqueue itself threw, or the
      // transaction failed at COMMIT after this callback had already
      // returned — did not survive. Delete the now-unreferenced object
      // rather than leaving it orphaned in storage forever.
      // storageService.remove() never throws (logs failures for orphan
      // reconciliation instead), so this can't mask the error below.
      await storageService.remove(newlyUploadedStorageKey);
    }
    throw error;
  }

  return outcome;
}

registerSystemJobHandler("GENERATE_APPROVAL_PDF", processApprovalPdfJob);

// Outbox job handler for GENERATE_COMPLETION_PDF, enqueued inside the same
// transaction that completes the Gate Pass (see recordReturn).
//
// Same discipline as the approval job, for the same reasons: idempotent by
// re-deriving "already done?" from a committed COMPLETED_PDF row rather than
// from anything about its own prior attempts, and compensating for a
// non-transactional object upload if the transaction that would reference it
// does not survive.
//
// Completion is already committed before this ever runs, so nothing here can
// roll it back: a render failure, a storage failure, an unreachable WhatsApp
// provider or an unconfirmed send all leave the Gate Pass COMPLETED and only
// affect this retryable job.
async function processCompletionPdfJob(item) {
  const gatePassId = item.entity_id;
  const outcome = { status: "SENT" };
  let newlyUploadedStorageKey = null;

  try {
    await withTransaction(async (client) => {
      const gatePass = await repo.lockDetailById(client, gatePassId);

      if (!gatePass) return;

      if (gatePass.status !== GATE_PASS_STATUS.COMPLETED) {
        // Nothing to close out. Terminal rather than retried forever.
        outcome.status = "VOID";
        return;
      }

      const existing = await repo.findLatestCompletionPdf(gatePassId, client);
      let storageKey = existing?.storage_key;

      if (!storageKey) {
        const [items, evidenceRows] = await Promise.all([
          repo.findItemsByGatePassId(gatePassId),
          repo.listEvidenceFilesForRender(gatePassId, client),
        ]);

        // Photo bytes are read back out of storage here rather than being
        // carried through the outbox payload — an outbox row must stay small
        // and must never become a second copy of the evidence.
        const evidence = [];
        for (const row of evidenceRows) {
          try {
            evidence.push({ ...row, buffer: await storageService.read(row.storage_key) });
          } catch (error) {
            // A missing object must not block closing out the Gate Pass; the
            // document reports the rest of the evidence truthfully.
            logServerError(error, undefined, { operation: "gate-pass.completion-pdf.read", gatePassId });
          }
        }

        const pdfBuffer = await generateGatePassCompletionPdf(gatePass, items, evidence);
        const version = await repo.nextCompletionPdfVersion(gatePassId, client);
        const saved = await storageService.save(pdfBuffer, {
          gatePassId,
          category: "completion-pdf",
          extension: "pdf",
        });
        storageKey = saved.storageKey;
        newlyUploadedStorageKey = saved.storageKey;

        await repo.insertFile(client, {
          gatePassId,
          fileType: "COMPLETED_PDF",
          storageKey: saved.storageKey,
          mimeType: "application/pdf",
          sizeBytes: saved.sizeBytes,
          checksumSha256: saved.checksumSha256,
          version,
          createdByUserId: item.payload.completedByUserId,
        });
      }

      await enqueue(client, [
        {
          channel: "WHATSAPP",
          eventType: "GATE_PASS_COMPLETED",
          entityType: "GATE_PASS",
          entityId: gatePassId,
          recipientPhone: gatePass.driver_phone,
          recipientSiteId: gatePass.site_id,
          idempotencyKey: `whatsapp-completion:${gatePassId}`,
          payload: {
            storageKey,
            filename: `${gatePass.gate_pass_number}-completion.pdf`,
            caption: `Gate Pass ${gatePass.gate_pass_number} completed.`,
          },
        },
      ]);
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

registerSystemJobHandler("GENERATE_COMPLETION_PDF", processCompletionPdfJob);

export { processCompletionPdfJob };

export async function getCompletionPdf(actor, gatePassId) {
  const gatePass = await repo.findById(gatePassId);

  if (!gatePass || !canReadGateEvidence(actor, gatePass)) {
    throw new NotFoundError("Gate Pass not found.");
  }

  const file = await repo.findLatestCompletionPdf(gatePassId);

  if (!file) {
    // Not 404: the caller may see this Gate Pass, and its completion document
    // is generated by the durable outbox job shortly after the return is
    // recorded. Answering 404 made "still generating" indistinguishable from
    // "no such pass / not yours", so a Guard who finished a return and tapped
    // straight through saw a not-found error for a document that was on its
    // way. 503 says "ask again", which is what is actually true.
    throw new ServiceUnavailableError("The completion document is still being generated. Try again shortly.");
  }

  return { buffer: await storageService.read(file.storage_key), mimeType: file.mime_type };
}

// Exposed for tests: lets a test invoke finalization directly (e.g.
// concurrently with a real cancel request) instead of only via the
// registry/poll loop.
export { processApprovalPdfJob };

// Fix #6 defense-in-depth layer 2, shared by every channel/job type keyed
// off a Gate Pass (currently SYSTEM PDF generation and the WHATSAPP send
// that follows it): a cancelled pass is never deliverable, no matter which
// job is asking.
registerEntityRecheckHandler("GATE_PASS", async (gatePassId) => {
  const gatePass = await repo.findById(gatePassId);
  return Boolean(gatePass) && gatePass.status !== GATE_PASS_STATUS.CANCELLED;
});

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

// Stores a batch of evidence photos for one event and returns the file id of
// the FIRST one, which exit/return then write into their primary photo
// column (the column the status-coherence CHECK requires to be non-null).
//
// Callers pass every storage key they created into `uploaded` so the
// compensating cleanup in their catch block can remove all of them if the
// transaction does not survive — the same discipline the single-photo path
// already used, extended to a batch.
async function storeEvidenceBatch(client, { gatePassId, photos, fileType, actorId, note, uploaded, category }) {
  const existing = await repo.countEvidenceFiles(client, gatePassId);
  if (existing + photos.length > MAX_EVIDENCE_PHOTOS_PER_GATE_PASS) {
    throw new ValidationError(
      `A Gate Pass can hold at most ${MAX_EVIDENCE_PHOTOS_PER_GATE_PASS} evidence photos.`,
    );
  }

  const fileIds = [];
  let version = await repo.nextEvidenceVersion(client, gatePassId, fileType);

  for (const photo of photos) {
    const saved = await storageService.save(photo.buffer, {
      gatePassId,
      category,
      extension: photo.extension,
    });
    uploaded.push(saved.storageKey);

    fileIds.push(
      await repo.insertFile(client, {
        gatePassId,
        fileType,
        storageKey: saved.storageKey,
        mimeType: photo.mimeType,
        sizeBytes: saved.sizeBytes,
        checksumSha256: saved.checksumSha256,
        version,
        createdByUserId: actorId,
        evidenceNote: note ?? null,
      }),
    );

    version += 1;
  }

  return fileIds[0];
}

// Additional gate evidence captured outside the exit/return transitions.
//
// The INBOUND_ADDITIONAL kind exists for the case the gate actually hits:
// something comes back that was never on the approved pass. That photo is
// accepted as evidence in its own right — it is never appended to the
// approved item list and never re-opens an approved Gate Pass, so approved
// history stays exactly as it was approved.
export async function addEvidence(actor, id, { kind, note, photos }) {
  const fileType = EVIDENCE_FILE_TYPE[kind];
  if (!fileType) throw new ValidationError("Unknown evidence kind.");

  if (!photos?.length) throw new ValidationError("At least one photo is required.");

  const outbound = kind === EVIDENCE_KIND.OUTBOUND;
  if (!actor.permissions.has(outbound ? "gate_pass.exit" : "gate_pass.return")) {
    throw new ForbiddenError();
  }

  if (kind === EVIDENCE_KIND.INBOUND_ADDITIONAL && !note) {
    throw new ValidationError("Describe what this additional inbound evidence shows.");
  }

  const uploaded = [];

  try {
    return await withTransaction(async (client) => {
      const gatePass = await repo.lockById(client, id);

      if (!gatePass || gatePass.site_id !== actor.siteId) {
        throw new NotFoundError("Gate Pass not found.");
      }

      // Evidence attaches to a pass that has actually been through the gate.
      // A DRAFT/PENDING/REJECTED/CANCELLED pass has no gate event to
      // document, and COMPLETED stays open for late-arriving inbound
      // evidence rather than forcing a Guard to reopen a closed record.
      const allowed = outbound
        ? [GATE_PASS_STATUS.VEHICLE_OUTSIDE, GATE_PASS_STATUS.COMPLETED]
        : [GATE_PASS_STATUS.VEHICLE_OUTSIDE, GATE_PASS_STATUS.COMPLETED];

      if (!allowed.includes(gatePass.status)) {
        throw new ConflictError(
          `Cannot attach gate evidence to a Gate Pass currently in ${gatePass.status} state.`,
        );
      }

      const fileId = await storeEvidenceBatch(client, {
        gatePassId: id,
        photos,
        fileType,
        actorId: actor.id,
        note: note ?? null,
        uploaded,
        category: outbound ? "departure" : "return",
      });

      await repo.insertAuditLog(client, {
        gatePassId: id,
        actorUserId: actor.id,
        action: "EVIDENCE",
        previousStatus: gatePass.status,
        newStatus: gatePass.status,
        metadata: { kind, photoCount: photos.length, ...(note ? { note } : {}) },
      });

      return { fileId, count: photos.length };
    });
  } catch (error) {
    for (const key of uploaded) {
      await storageService.remove(key);
    }
    throw error;
  }
}

// A Guard holds none of the view_own/view_site reporting permissions, but
// must be able to see the evidence they and their colleagues captured at the
// same gate. Site is still absolute for them, exactly as it is everywhere
// else in this module.
export function canReadGateEvidence(actor, gatePass) {
  if (isWithinGatePassScope(actor, gatePass)) return true;

  const isGuard = ["gate_pass.verify", "gate_pass.exit", "gate_pass.return"].some((code) =>
    actor.permissions.has(code),
  );

  return isGuard && gatePass.site_id === actor.siteId;
}

export async function listEvidence(actor, id) {
  const gatePass = await repo.findById(id);

  if (!gatePass || !canReadGateEvidence(actor, gatePass)) {
    throw new NotFoundError("Gate Pass not found.");
  }

  return repo.listEvidenceFiles(id);
}

export async function recordExit(actor, id, { odometer, photo, photos }) {
  if (!actor.permissions.has("gate_pass.exit")) {
    throw new ForbiddenError();
  }

  const evidence = photos?.length ? photos : photo ? [photo] : [];

  if (!evidence.length) {
    throw new ValidationError("A departure photo is required.");
  }

  // Every state-dependent check runs, under the row lock, before a single
  // byte is written to disk — a rejected transition never creates a file
  // nothing will ever reference. If the write to disk succeeds but the
  // transaction that was going to reference it doesn't, the compensating
  // remove() below cleans it up rather than leaking it.
  const uploaded = [];

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

      const photoFileId = await storeEvidenceBatch(client, {
        gatePassId: id,
        photos: evidence,
        fileType: "DEPARTURE_PHOTO",
        actorId: actor.id,
        uploaded,
        category: "departure",
      });

      await repo.markExited(client, id, { odometer, byUserId: actor.id, photoFileId });

      await repo.insertAuditLog(client, {
        gatePassId: id,
        actorUserId: actor.id,
        action: "EXIT",
        previousStatus: GATE_PASS_STATUS.APPROVED,
        newStatus: GATE_PASS_STATUS.VEHICLE_OUTSIDE,
        metadata: { odometer, photoCount: evidence.length },
      });
    });
  } catch (error) {
    for (const key of uploaded) {
      await storageService.remove(key);
    }
    throw error;
  }
}

export async function recordReturn(actor, id, { odometer, photo, photos, remarks }) {
  if (!actor.permissions.has("gate_pass.return")) {
    throw new ForbiddenError();
  }

  const evidence = photos?.length ? photos : photo ? [photo] : [];

  if (!evidence.length) {
    throw new ValidationError("A return photo is required.");
  }

  // Same ordering as recordExit: validate under the row lock first, write
  // to disk only once the transition is known-good, and compensate with a
  // remove() if the transaction fails after the write anyway.
  const uploaded = [];

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

      const photoFileId = await storeEvidenceBatch(client, {
        gatePassId: id,
        photos: evidence,
        fileType: "RETURN_PHOTO",
        actorId: actor.id,
        uploaded,
        category: "return",
      });

      await repo.markReturned(client, id, { odometer, byUserId: actor.id, photoFileId, remarks });

      await repo.insertAuditLog(client, {
        gatePassId: id,
        actorUserId: actor.id,
        action: "RETURN",
        previousStatus: GATE_PASS_STATUS.VEHICLE_OUTSIDE,
        newStatus: GATE_PASS_STATUS.COMPLETED,
        metadata: { odometer, photoCount: evidence.length },
      });

      // Completion commits first; the PDF and its WhatsApp delivery are a
      // durable follow-up job. A render, storage or provider failure can
      // therefore never roll back or block the Gate Pass being completed.
      await enqueue(client, [
        {
          channel: "SYSTEM",
          eventType: "GENERATE_COMPLETION_PDF",
          entityType: "GATE_PASS",
          entityId: id,
          recipientSiteId: gatePass.site_id,
          idempotencyKey: `generate-completion-pdf:${id}`,
          payload: { completedByUserId: actor.id },
        },
      ]);
    });
  } catch (error) {
    for (const key of uploaded) {
      await storageService.remove(key);
    }
    throw error;
  }
}

export async function getAuthorizedFile(actor, gatePassId, fileId) {
  const gatePass = await repo.findById(gatePassId);

  // Guards may read back the evidence captured at their own gate; everyone
  // else needs the ordinary reporting scope. IDOR protection is the second
  // check below: a file id is only ever served when it actually belongs to
  // the Gate Pass whose scope was just verified, so guessing a file id from
  // another record yields "not found", never its bytes.
  if (!gatePass || !canReadGateEvidence(actor, gatePass)) {
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
