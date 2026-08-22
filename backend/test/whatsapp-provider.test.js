import { test } from "node:test";
import assert from "node:assert/strict";
import { DemoWhatsAppProvider } from "../src/shared/notifications/whatsapp-provider.js";

test("demo WhatsApp provider redacts the phone number in its log output", async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (message) => logs.push(message);

  try {
    await new DemoWhatsAppProvider().sendDocument({
      toPhone: "+923001234567",
      idempotencyKey: "whatsapp-approval:test",
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes("+923001234567"), "full phone number must not appear in logs");
  assert.match(logs[0], /\*\*\*4567/);
});

test("demo WhatsApp provider never reports a real SENT status", async () => {
  const result = await new DemoWhatsAppProvider().sendDocument({ toPhone: "+923001234567" });
  assert.equal(result.status, "SIMULATED");
});
