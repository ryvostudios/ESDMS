// Interface: any provider implements
// sendDocument({ toPhone, documentBuffer, filename, caption, idempotencyKey })
// -> { status: "SENT" | "SIMULATED" | "UNCERTAIN", providerMessageId }.
//
// idempotencyKey is derived from the outbox row (see outbox.processor.js)
// and stays the same across every retry of the same job — a real provider
// that supports idempotent requests (Meta's Cloud API accepts a client
// message ID for this) can use it to recognize "I already accepted this
// exact send" after a worker crash-and-retry, instead of dispatching a
// second real message.
//
// UNCERTAIN means the provider's own response didn't confirm accept vs.
// reject before the request ended (timeout, connection drop mid-response)
// — genuinely unknown, not a retryable failure. A caller must never
// silently retry-as-fresh on UNCERTAIN; see outbox.processor.js.
//
// No real Meta WhatsApp Business Cloud API credentials are configured for
// this demo, so DemoWhatsAppProvider is used. It must never report "SENT" —
// only "SIMULATED" — so nobody mistakes a demo run for a real delivery.

// Driver/personal phone numbers are PII — logs (console output, any log
// aggregator it ends up in) are a wider-audience surface than the DB row
// they already live in, so only the last 4 digits are ever printed here.
function redactPhone(phone) {
  if (!phone || phone.length <= 4) return "***";
  return `***${phone.slice(-4)}`;
}

export class DemoWhatsAppProvider {
  async sendDocument({ toPhone, idempotencyKey }) {
    console.log(
      `[whatsapp:demo] Simulated document delivery to ${redactPhone(toPhone)} (idempotencyKey=${idempotencyKey})`,
    );

    return {
      status: "SIMULATED",
      providerMessageId: null,
    };
  }
}

export const whatsAppProvider = new DemoWhatsAppProvider();
