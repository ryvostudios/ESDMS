import { test } from "node:test";
import assert from "node:assert/strict";
import PDFDocument from "pdfkit";
import { generateGatePassCompletionPdf } from "../src/modules/gate-pass/gate-pass.completion-pdf.js";

// Same approach as gate-pass-pdf.test.js: pdfkit FlateDecode-compresses every
// content stream, so a byte search over the finished PDF cannot see rendered
// text. Recording PDFDocument.prototype.text calls observes exactly what the
// generator drew.
function recordTextCalls() {
  const calls = [];
  const original = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function patchedText(text, ...rest) {
    calls.push(String(text));
    return original.call(this, text, ...rest);
  };
  return { calls, restore: () => { PDFDocument.prototype.text = original; } };
}

// A 1x1 PNG — real bytes, so doc.image() takes its normal path.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function gatePass(overrides = {}) {
  return {
    gate_pass_number: "ESD-2026-000001",
    status: "COMPLETED",
    site_name: "E-Set — Main Site",
    issuing_department_name: "Administration",
    requested_by: "Ayesha Siddiqui",
    destination: "Lahore Repair Workshop",
    purpose: "REPAIR_RECTIFICATION",
    job_order_id: null,
    created_at: new Date("2026-08-29T06:40:00Z"),
    driver_name: "Imran Khalid",
    driver_phone: "+923004455667",
    vehicle_registration: "LES-4471",
    approved_by_name: "Ayesha Siddiqui",
    approved_at: new Date("2026-08-29T06:41:00Z"),
    expected_return_date: null,
    departure_at: new Date("2026-08-29T06:42:00Z"),
    departure_by_name: "Bilal Ahmed",
    return_at: new Date("2026-08-29T06:43:00Z"),
    return_by_name: "Bilal Ahmed",
    return_remarks: null,
    remarks: null,
    ...overrides,
  };
}

const items = [{ description: "Hydraulic pump assembly", part_number: null, quantity: "1.00", unit: "pcs" }];

function evidence() {
  const base = { buffer: PNG, created_at: new Date("2026-08-29T06:42:00Z"), captured_by_name: "Bilal Ahmed" };
  return [
    { ...base, file_type: "DEPARTURE_PHOTO", evidence_note: null },
    { ...base, file_type: "DEPARTURE_PHOTO", evidence_note: null },
    { ...base, file_type: "DEPARTURE_PHOTO", evidence_note: null },
    { ...base, file_type: "RETURN_PHOTO", evidence_note: null },
    { ...base, file_type: "RETURN_PHOTO", evidence_note: null },
    { ...base, file_type: "RETURN_ADDITIONAL_PHOTO", evidence_note: "Unlisted 200L drum returned on the truck bed" },
  ];
}

test("the completion PDF separates outbound and inbound evidence and labels unlisted inbound items", async () => {
  const recorder = recordTextCalls();
  let buffer;
  try {
    buffer = await generateGatePassCompletionPdf(gatePass(), items, evidence());
  } finally {
    recorder.restore();
  }

  const drawn = recorder.calls.join("\n");

  assert.equal(buffer.subarray(0, 5).toString("ascii"), "%PDF-");

  // It is a closure record, not a re-print of the approval document.
  assert.match(drawn, /Completion Record/);
  assert.match(drawn, /ESD-2026-000001/);
  assert.match(drawn, /Final status: COMPLETED/);

  // The facts a closure record exists to carry.
  for (const field of [
    "E-Set — Main Site",
    "Administration",
    "Ayesha Siddiqui",
    "Lahore Repair Workshop",
    "REPAIR RECTIFICATION",
    "Imran Khalid",
    "LES-4471",
    "Hydraulic pump assembly",
    "Actual Exit Time",
    "Actual Return / Entry Time",
    "Bilal Ahmed",
  ]) {
    assert.ok(drawn.includes(field), `completion PDF must carry "${field}"`);
  }

  // Two clearly separated evidence sections, with honest counts.
  assert.match(drawn, /OUTBOUND EVIDENCE/);
  assert.match(drawn, /INBOUND \/ RETURN EVIDENCE/);
  assert.match(drawn, /3 photo\(s\) captured at the gate when this Gate Pass exited/);
  assert.match(drawn, /2 photo\(s\) captured at the gate on return \/ entry/);

  // The unlisted item is labelled as gate evidence and explicitly NOT approved.
  assert.match(drawn, /Additional inbound evidence captured at gate/);
  assert.match(drawn, /NOT part of the approved/);
  assert.ok(drawn.includes("Unlisted 200L drum returned on the truck bed"));

  // Guard-facing documents never carry commercial data.
  for (const word of ["PKR", "Unit Price", "Line Total", "Grand Total", "Estimated"]) {
    assert.ok(!drawn.includes(word), `completion PDF must not contain "${word}"`);
  }
});

test("a completion PDF with no additional evidence omits the additional-evidence section entirely", async () => {
  const recorder = recordTextCalls();
  try {
    await generateGatePassCompletionPdf(
      gatePass(),
      items,
      evidence().filter((photo) => photo.file_type !== "RETURN_ADDITIONAL_PHOTO"),
    );
  } finally {
    recorder.restore();
  }

  const drawn = recorder.calls.join("\n");
  assert.ok(!drawn.includes("Additional inbound evidence captured at gate"));
  assert.match(drawn, /OUTBOUND EVIDENCE/);
});
