import pool from "../../config/database.js";
import { whatsAppProvider } from "./whatsapp-provider.js";
import { storageService } from "../storage/storage-service.js";
import { claimBatch, markDelivered, markFailed, reconcileStaleExternalDeliveries } from "./outbox.repository.js";

// SYSTEM jobs are shared-shape (same outbox table/claim logic) but their
// actual work is domain-specific — a module registers its own handler by
// event_type instead of this file importing that module's internals
// directly, keeping this processor genuinely generic the way the outbox
// table itself already is (see gate-pass-schema migration).
const systemJobHandlers = new Map();

export function registerSystemJobHandler(eventType, handler) {
  systemJobHandlers.set(eventType, handler);
}

// Same reasoning, applied to a second concern: before actually delivering
// ANY channel's job, the owning domain gets one more chance to say "this
// entity is no longer in a deliverable state" (e.g. a Gate Pass cancelled
// after its WhatsApp job was already claimed by a worker — see Fix #6).
// Returns true if still safe to deliver.
const entityRecheckHandlers = new Map();

export function registerEntityRecheckHandler(entityType, handler) {
  entityRecheckHandlers.set(entityType, handler);
}

async function stillDeliverable(item) {
  const recheck = entityRecheckHandlers.get(item.entity_type);
  return !recheck || (await recheck(item.entity_id));
}

const BATCH_SIZE = 20;

// Drains the channel fully rather than grabbing one static batch per tick —
// a batch that comes back full means there may be more, so claim again
// immediately instead of leaving the rest queued until the next interval.
// processItem resolves to the {status, providerMessageId} to record as
// delivered, or throws to record a failed attempt.
async function drain(channel, processItem) {
  for (;;) {
    const claimed = await claimBatch(channel, BATCH_SIZE);

    for (const item of claimed) {
      try {
        if (!(await stillDeliverable(item))) {
          await markDelivered(pool, item.id, "VOID", null);
          continue;
        }

        const { status, providerMessageId = null } = await processItem(item);
        await markDelivered(pool, item.id, status, providerMessageId);
      } catch (error) {
        await markFailed(pool, item.id, error.message);
      }
    }

    if (claimed.length < BATCH_SIZE) {
      return;
    }
  }
}

async function processWhatsAppOnce() {
  // Sweep any stale PROCESSING row (worker crashed mid-send, lease
  // expired) to UNCERTAIN before claiming — WHATSAPP is an external
  // delivery channel, so claimBatch itself never reclaims a stale
  // PROCESSING row for it (see outbox.repository.js).
  await reconcileStaleExternalDeliveries("WHATSAPP");

  await drain("WHATSAPP", async (item) => {
    const documentBuffer = await storageService.read(item.payload.storageKey);

    // A stable key derived from this outbox row, not a fresh random value
    // per attempt — a real provider can use it to recognize "I already
    // accepted this exact send" across a worker crash-and-retry instead of
    // dispatching a second real message. See docs/DECISIONS.md.
    return whatsAppProvider.sendDocument({
      toPhone: item.recipient_phone,
      documentBuffer,
      filename: item.payload.filename,
      caption: item.payload.caption,
      idempotencyKey: item.idempotency_key,
    });
  });
}

async function processSystemOnce() {
  await drain("SYSTEM", async (item) => {
    const handler = systemJobHandlers.get(item.event_type);

    if (!handler) {
      throw new Error(`No handler registered for SYSTEM job type "${item.event_type}".`);
    }

    // The handler owns its own transaction (it typically also needs to
    // write domain rows and/or enqueue a follow-up job atomically with
    // marking this one SENT) — retried freely since it re-derives its
    // work from durable state rather than trusting a prior partial run.
    // It returns the status this job should be recorded with (normally
    // SENT, or VOID if it detected its own cancellation race).
    return handler(item);
  });
}

// Approval must never block on WhatsApp/PDF generation availability, so
// delivery happens here, out-of-band, after the approval transaction has
// already committed. A simple poll interval is enough for this demo's
// traffic volume; a real job queue is the upgrade path if throughput ever
// requires it.
async function processOnce() {
  await processSystemOnce();
  await processWhatsAppOnce();
}

// A run already in flight (own tick still draining, or the initial
// kick-off below) must never overlap with another — two concurrent drains
// of the same channel would both be claiming with FOR UPDATE SKIP LOCKED
// safely, but there is no reason to ever run them concurrently, and
// overlap would make "is the queue actually idle" harder to reason about.
let running = false;

async function processOnceNonOverlapping() {
  if (running) return;
  running = true;

  try {
    await processOnce();
  } catch (error) {
    console.error("Outbox processor error:", error);
  } finally {
    running = false;
  }
}

export function startOutboxProcessor(intervalMs = 30_000) {
  // Run once immediately on startup rather than waiting out the first
  // interval — a server restart (deploy, crash recovery) must not leave a
  // freshly-approved Gate Pass's PDF pending for up to intervalMs with
  // nothing to prompt it sooner.
  processOnceNonOverlapping();

  const timer = setInterval(processOnceNonOverlapping, intervalMs);
  timer.unref();

  return () => clearInterval(timer);
}

// Exposed for tests: drain both channels synchronously instead of waiting
// on the poll interval.
export { processOnce };
