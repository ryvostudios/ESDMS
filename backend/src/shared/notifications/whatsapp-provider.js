import config from "../../config/env.js";

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

// Official WhatsApp Business Platform (Meta Cloud API) client.
//
// Deliberately the ONLY kind of provider this system will ever ship: no
// WhatsApp Web scraping, no headless-browser automation, no reverse-
// engineered session library, no personal-account cookie reuse. Those
// violate WhatsApp's terms, break without warning, and would put a real
// business account at risk of a ban — an unacceptable dependency for a
// document that carries commercial information.
//
// Sending a document is two calls: upload the bytes to /media, then send a
// document message referencing the returned media id. Both are bounded by an
// AbortSignal timeout so a hung provider can never pin an outbox worker.
//
// A network/timeout failure AFTER the send request was dispatched is
// reported as UNCERTAIN, never as a plain failure: the message may well have
// been accepted, and outbox.repository.js deliberately never auto-retries
// UNCERTAIN precisely so a real duplicate WhatsApp message can never be sent
// to a live business group.
const REQUEST_TIMEOUT_MS = 20_000;

export class CloudApiWhatsAppProvider {
  constructor(settings) {
    this.settings = settings;
  }

  get #endpointBase() {
    const { apiBaseUrl, apiVersion, phoneNumberId } = this.settings;
    return `${apiBaseUrl.replace(/\/+$/, "")}/${apiVersion}/${phoneNumberId}`;
  }

  async #request(path, { body, headers = {} }) {
    const response = await fetch(`${this.#endpointBase}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.settings.accessToken}`, ...headers },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      // The provider's own error text can echo submitted content, so it is
      // never propagated verbatim into a durable outbox row (ESDMS-021 —
      // see outbox.processor.js#classifyOutboxFailure).
      throw new Error(`whatsapp provider responded ${response.status}`);
    }

    return response.json();
  }

  async sendDocument({ toPhone, documentBuffer, filename, caption, idempotencyKey }) {
    const upload = new FormData();
    upload.append("messaging_product", "whatsapp");
    upload.append("type", "application/pdf");
    upload.append("file", new Blob([documentBuffer], { type: "application/pdf" }), filename);

    const media = await this.#request("/media", { body: upload });

    let sent;
    try {
      sent = await this.#request("/messages", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: toPhone,
          type: "document",
          // Carried through so a provider that supports request
          // deduplication can recognise a retry of this exact send.
          biz_opaque_callback_data: idempotencyKey,
          document: { id: media.id, filename, caption },
        }),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        return { status: "UNCERTAIN", providerMessageId: null };
      }
      throw error;
    }

    return { status: "SENT", providerMessageId: sent?.messages?.[0]?.id ?? null };
  }
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

// Fully configured official provider, or the clearly-labelled demo provider
// that only ever reports SIMULATED. Selection happens once, at startup, so a
// half-configured deployment can never silently send from a real account.
function resolveProvider() {
  const { enabled, accessToken, phoneNumberId } = config.whatsapp;

  if (enabled && accessToken && phoneNumberId) {
    return new CloudApiWhatsAppProvider(config.whatsapp);
  }

  return new DemoWhatsAppProvider();
}

// True only when a real, fully configured official provider is active.
// Callers use this to decide whether to queue a delivery at all, or to record
// it as deliberately not attempted (DISABLED) — see
// shared/documents/document-delivery.js.
export function isWhatsAppDeliveryEnabled() {
  const { enabled, accessToken, phoneNumberId } = config.whatsapp;
  return Boolean(enabled && accessToken && phoneNumberId);
}

export const whatsAppProvider = resolveProvider();
