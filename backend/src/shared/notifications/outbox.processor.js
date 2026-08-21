import { whatsAppProvider } from "./whatsapp-provider.js";
import { storageService } from "../storage/storage-service.js";
import { findPendingWhatsApp, markDelivered, markFailed } from "./outbox.repository.js";

// Approval must never block on WhatsApp availability, so delivery happens
// here, out-of-band, after the approval transaction has already committed.
// A simple poll interval is enough for this demo's traffic volume; a real
// job queue is the upgrade path if throughput ever requires it.
async function processOnce() {
  const pending = await findPendingWhatsApp();

  for (const item of pending) {
    try {
      const documentBuffer = await storageService.read(item.payload.storageKey);

      const result = await whatsAppProvider.sendDocument({
        toPhone: item.recipient_phone,
        documentBuffer,
        filename: item.payload.filename,
        caption: item.payload.caption,
      });

      await markDelivered(item.id, result.status, result.providerMessageId);
    } catch (error) {
      await markFailed(item.id, error.message);
    }
  }
}

export function startOutboxProcessor(intervalMs = 30_000) {
  const timer = setInterval(() => {
    processOnce().catch((error) => console.error("Outbox processor error:", error));
  }, intervalMs);

  timer.unref();

  return () => clearInterval(timer);
}
