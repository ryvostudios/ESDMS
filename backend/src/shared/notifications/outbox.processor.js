import pool from "../../config/database.js";
import { whatsAppProvider } from "./whatsapp-provider.js";
import { storageService } from "../storage/storage-service.js";
import { claimBatch, markDelivered, markFailed } from "./outbox.repository.js";

// SYSTEM jobs are shared-shape (same outbox table/claim logic) but their
// actual work is domain-specific — a module registers its own handler by
// event_type instead of this file importing that module's internals
// directly, keeping this processor genuinely generic the way the outbox
// table itself already is (see gate-pass-schema migration).
const systemJobHandlers = new Map();

export function registerSystemJobHandler(eventType, handler) {
  systemJobHandlers.set(eventType, handler);
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
  await drain("WHATSAPP", async (item) => {
    const documentBuffer = await storageService.read(item.payload.storageKey);

    return whatsAppProvider.sendDocument({
      toPhone: item.recipient_phone,
      documentBuffer,
      filename: item.payload.filename,
      caption: item.payload.caption,
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
    await handler(item);

    return { status: "SENT" };
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

export function startOutboxProcessor(intervalMs = 30_000) {
  const timer = setInterval(() => {
    processOnce().catch((error) => console.error("Outbox processor error:", error));
  }, intervalMs);

  timer.unref();

  return () => clearInterval(timer);
}

// Exposed for tests: drain both channels synchronously instead of waiting
// on the poll interval.
export { processOnce };
