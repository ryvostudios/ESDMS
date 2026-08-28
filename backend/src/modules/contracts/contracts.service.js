import pool from "../../config/database.js";
import { withTransaction } from "../../shared/db/with-transaction.js";
import { storageService } from "../../shared/storage/storage-service.js";
import { ValidationError, ForbiddenError, NotFoundError, ConflictError, ServiceUnavailableError } from "../../shared/errors/app-error.js";
import { getEmployee } from "../employees/employees.service.js";
import { recordHistory } from "../workforce/business-history.repository.js";
import { notifyEmployee } from "../workforce/workforce-notify.js";
import { recordGovernanceAudit } from "../../shared/audit/governance-audit.repository.js";
import * as repo from "./contracts.repository.js";

function isSelfActor(actor, employeeId) {
  return actor.employeeId === employeeId;
}

function contractMetadata(contract) {
  if (!contract) return contract;
  const { storage_key: storageKey, ...safe } = contract;
  return { ...safe, has_file: Boolean(storageKey) };
}

// Self access is real, but narrower than HR/CEO access: an employee sees
// only their own FINALIZED contracts (never a DRAFT — nothing has been
// agreed yet) and can only view/download, never mutate. Every write
// requires the specific contract.* permission regardless of actor —
// contract access is deliberately separate from ordinary employees.*/HR
// access (docs/DECISIONS.md).
async function assertViewable(actor, employee, contract) {
  if (isSelfActor(actor, employee.id)) {
    if (contract.status === "DRAFT") throw new ForbiddenError();
    return;
  }
  if (!actor.permissions.has("contract.view")) throw new ForbiddenError();
}

export async function listContracts(actor, employeeId) {
  const employee = await getEmployee(actor, employeeId);
  const self = isSelfActor(actor, employee.id);
  if (!self && !actor.permissions.has("contract.view")) throw new ForbiddenError();

  const rows = await repo.listForEmployee(employee.id, { includeDrafts: !self });
  return rows.map(contractMetadata);
}

async function loadContractForEmployee(actor, employeeId, contractId) {
  const employee = await getEmployee(actor, employeeId);
  const contract = await repo.findById(contractId);
  if (!contract || contract.employee_id !== employee.id) throw new NotFoundError("Contract not found.");
  return { employee, contract };
}

export async function createDraft(actor, employeeId, input) {
  const employee = await getEmployee(actor, employeeId);
  if (!actor.permissions.has("contract.create")) throw new ForbiddenError();

  let amendsContract = null;
  if (input.kind === "AMENDMENT") {
    if (!actor.permissions.has("contract.amend")) throw new ForbiddenError();
    amendsContract = await repo.findById(input.amendsContractId);
    if (!amendsContract || amendsContract.employee_id !== employee.id || amendsContract.status === "DRAFT") {
      throw new ValidationError("Amendment must reference an already-finalized contract for this employee.");
    }
  }

  return withTransaction(async (client) => {
    const contractNumber = await repo.nextContractNumber(client, input.kind);
    const draft = await repo.insertDraft(client, {
      employeeId: employee.id,
      contractNumber,
      kind: input.kind,
      amendsContractId: amendsContract?.id,
      effectiveStartDate: input.effectiveStartDate,
      termsSummary: input.termsSummary,
      createdByUserId: actor.id,
    });
    return contractMetadata(draft);
  });
}

export async function updateDraftMetadata(actor, employeeId, contractId, input) {
  const { contract } = await loadContractForEmployee(actor, employeeId, contractId);
  if (!actor.permissions.has("contract.edit_draft")) throw new ForbiddenError();
  if (contract.status !== "DRAFT") throw new ConflictError("Only a DRAFT contract can be edited.");

  return contractMetadata(await withTransaction((client) => repo.updateDraftMetadata(client, contract.id, input)));
}

export async function uploadDraftFile(actor, employeeId, contractId, file) {
  const { contract } = await loadContractForEmployee(actor, employeeId, contractId);
  if (!actor.permissions.has("contract.edit_draft")) throw new ForbiddenError();
  if (contract.status !== "DRAFT") throw new ConflictError("Only a DRAFT contract's file can be replaced.");

  const previousKey = contract.storage_key;
  let newKey;
  try {
    const result = await withTransaction(async (client) => {
      const saved = await storageService.save(file.buffer, {
        gatePassId: contract.id,
        category: "draft",
        extension: file.extension,
        namespace: "workforce",
      });
      newKey = saved.storageKey;

      const updated = await repo.replaceDraftFile(client, contract.id, {
        storageKey: saved.storageKey,
        mimeType: file.mimeType,
        sizeBytes: saved.sizeBytes,
        checksumSha256: saved.checksumSha256,
      });
      if (!updated) throw new ConflictError("Only a DRAFT contract's file can be replaced.");
      return updated;
    });

    // A draft file is mutable by design — the previous object is now
    // genuinely orphaned and safe to remove, unlike anything post-finalize.
    if (previousKey) await storageService.remove(previousKey);
    return contractMetadata(result);
  } catch (error) {
    if (newKey) await storageService.remove(newKey);
    throw error;
  }
}

export async function finalizeContract(actor, employeeId, contractId) {
  const { employee, contract } = await loadContractForEmployee(actor, employeeId, contractId);
  if (!actor.permissions.has("contract.finalize")) throw new ForbiddenError();
  if (contract.status !== "DRAFT") throw new ConflictError("Only a DRAFT contract can be finalized.");
  if (!contract.storage_key) throw new ValidationError("Upload the contract file before finalizing.");

  // Finalization is irreversible: the DB trigger makes every content column
  // immutable from here on, so an incomplete contract can never be repaired
  // afterwards. The effective start date and the terms summary are original
  // terms (docs/SECURITY.md) and the only human-readable record of what was
  // agreed, so they must be present before the record is frozen. The end
  // date stays optional — an open-ended permanent contract has none.
  if (!contract.effective_start_date) {
    throw new ValidationError("Set the effective start date before finalizing this contract.");
  }
  if (!contract.terms_summary) {
    throw new ValidationError("Add the terms summary before finalizing this contract.");
  }

  const storedFile = await storageService.read(contract.storage_key);
  if (!storageService.verifyChecksum(storedFile, contract.checksum_sha256)) {
    throw new ServiceUnavailableError("The stored contract failed its integrity check and cannot be finalized.");
  }

  return withTransaction(async (client) => {
    const finalized = await repo.finalize(client, contract.id, { finalizedByUserId: actor.id });
    if (!finalized) throw new ConflictError("Only a DRAFT contract can be finalized.");

    await recordHistory(client, {
      employeeId: employee.id,
      eventType: "CONTRACT_FINALIZED",
      summary: { contractNumber: finalized.contract_number, kind: finalized.kind },
      actorUserId: actor.id,
    });

    await recordGovernanceAudit(client, {
      actorUserId: actor.id,
      targetEmployeeId: employee.id,
      targetContractId: finalized.id,
      action: finalized.kind === "AMENDMENT" ? "CONTRACT_AMENDED" : "CONTRACT_FINALIZED",
      metadata: { contractNumber: finalized.contract_number, checksumSha256: finalized.checksum_sha256 },
    });

    await notifyEmployee(client, {
      employeeUserId: employee.user_id,
      siteId: employee.primary_site_id,
      eventType: "CONTRACT_FINALIZED",
      entityType: "EMPLOYEE_CONTRACT",
      entityId: finalized.id,
      // Contract terms/amount never enter notification payload text.
      payload: { contractNumber: finalized.contract_number },
    });

    return contractMetadata(finalized);
  });
}

// Closes out a finalized contract (superseded by a later one, its term
// expired, or termination) — status-only, the DB trigger blocks anything
// else. Never DRAFT -> anything through here (that's finalize/delete).
export async function transitionContract(actor, employeeId, contractId, { status }) {
  const { employee, contract } = await loadContractForEmployee(actor, employeeId, contractId);
  if (!actor.permissions.has("contract.edit_draft") && !actor.permissions.has("contract.finalize")) {
    throw new ForbiddenError();
  }
  if (contract.status !== "CURRENT") throw new ConflictError("Only a CURRENT contract can transition.");

  return withTransaction(async (client) => {
    const updated = await repo.transitionStatus(client, contract.id, { status });
    if (!updated) throw new ConflictError("Only a CURRENT contract can transition.");

    await recordHistory(client, {
      employeeId: employee.id,
      eventType: "CONTRACT_STATUS_CHANGED",
      summary: { contractNumber: updated.contract_number, status },
      actorUserId: actor.id,
    });

    return contractMetadata(updated);
  });
}

export async function deleteDraftContract(actor, employeeId, contractId) {
  const { contract } = await loadContractForEmployee(actor, employeeId, contractId);
  if (!actor.permissions.has("contract.edit_draft")) throw new ForbiddenError();
  if (contract.status !== "DRAFT") throw new ForbiddenError("Only a DRAFT contract can be deleted.");

  const deleted = await withTransaction((client) => repo.deleteDraft(client, contract.id));
  if (!deleted) throw new ConflictError("Only a DRAFT contract can be deleted.");
  if (deleted.storage_key) await storageService.remove(deleted.storage_key);
}

export async function downloadContract(actor, employeeId, contractId) {
  const { employee, contract } = await loadContractForEmployee(actor, employeeId, contractId);
  if (!actor.permissions.has("contract.download") && !isSelfActor(actor, employee.id)) throw new ForbiddenError();
  await assertViewable(actor, employee, contract);
  if (!contract.storage_key) throw new NotFoundError("This contract has no file yet.");

  const buffer = await storageService.read(contract.storage_key);
  if (!storageService.verifyChecksum(buffer, contract.checksum_sha256)) {
    throw new ServiceUnavailableError("The stored contract failed its integrity check.");
  }

  await recordGovernanceAudit(pool, {
    actorUserId: actor.id,
    targetEmployeeId: employee.id,
    targetContractId: contract.id,
    action: "CONTRACT_DOWNLOADED",
    metadata: { contractNumber: contract.contract_number },
  });

  return { buffer, mimeType: contract.mime_type, contractNumber: contract.contract_number };
}

export async function getContract(actor, employeeId, contractId) {
  const { employee, contract } = await loadContractForEmployee(actor, employeeId, contractId);
  await assertViewable(actor, employee, contract);

  await recordGovernanceAudit(pool, {
    actorUserId: actor.id,
    targetEmployeeId: employee.id,
    targetContractId: contract.id,
    action: "CONTRACT_VIEWED",
    metadata: { contractNumber: contract.contract_number },
  });

  return contractMetadata(contract);
}
