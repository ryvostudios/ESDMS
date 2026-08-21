// Interface: any provider implements sendDocument({ toPhone, documentBuffer,
// filename, caption }) -> { status: "SENT" | "SIMULATED", providerMessageId }.
// No real Meta WhatsApp Business Cloud API credentials are configured for
// this demo, so DemoWhatsAppProvider is used. It must never report "SENT" —
// only "SIMULATED" — so nobody mistakes a demo run for a real delivery.
export class DemoWhatsAppProvider {
  async sendDocument({ toPhone }) {
    console.log(`[whatsapp:demo] Simulated document delivery to ${toPhone}`);

    return {
      status: "SIMULATED",
      providerMessageId: null,
    };
  }
}

export const whatsAppProvider = new DemoWhatsAppProvider();
