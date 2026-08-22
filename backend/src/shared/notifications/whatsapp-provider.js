// Interface: any provider implements sendDocument({ toPhone, documentBuffer,
// filename, caption }) -> { status: "SENT" | "SIMULATED", providerMessageId }.
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
  async sendDocument({ toPhone }) {
    console.log(`[whatsapp:demo] Simulated document delivery to ${redactPhone(toPhone)}`);

    return {
      status: "SIMULATED",
      providerMessageId: null,
    };
  }
}

export const whatsAppProvider = new DemoWhatsAppProvider();
