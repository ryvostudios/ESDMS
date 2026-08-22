import { test } from "node:test";
import assert from "node:assert/strict";
import PDFDocument from "pdfkit";
import { generateGatePassPdf } from "../src/modules/gate-pass/gate-pass.pdf.js";

// pdfkit FlateDecode-compresses every content stream by default, so a raw
// byte search over the finished PDF can't see rendered text. Recording
// calls to PDFDocument.prototype.text while generating is a more direct,
// reliable way to verify what the generator actually drew — no PDF
// parsing involved, just observing the real render calls it makes.
function recordTextCalls() {
  const calls = [];
  const original = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function patchedText(text, ...rest) {
    calls.push({ text, args: rest });
    return original.call(this, text, ...rest);
  };
  return {
    calls,
    restore: () => {
      PDFDocument.prototype.text = original;
    },
  };
}

function baseGatePass(overrides = {}) {
  return {
    gate_pass_number: "ESD-2026-000001",
    created_at: new Date(),
    issuing_department_name: "Electrical",
    requested_by: "Test Requester",
    destination: "Site B Warehouse",
    driver_name: "Test Driver",
    driver_phone: "+923001234567",
    vehicle_registration: "TST-12345",
    job_order_id: null,
    purpose: "SAMPLE",
    expected_return_date: null,
    remarks: null,
    created_by_name: "Test Creator",
    approved_by_name: "Test Approver",
    approved_at: new Date(),
    ...overrides,
  };
}

test("PDF generation survives a long wrapped description without throwing, and produces a real PDF buffer", async () => {
  const items = [
    {
      description:
        "A very long item description that is expected to wrap across multiple lines inside the fixed-width description column of the items table, to exercise the row-height-follows-tallest-cell logic.",
      part_number: "PN-0001",
      quantity: 3,
      unit: "pcs",
    },
  ];

  const buffer = await generateGatePassPdf(baseGatePass(), items, "https://example.test/verify#token");

  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 1000);
  assert.equal(buffer.subarray(0, 5).toString("ascii"), "%PDF-");
});

test("PDF generation handles enough items to force a page break, and repeats the table header on the new page", async () => {
  const items = Array.from({ length: 60 }, (_, index) => ({
    description: `Item ${index}`,
    part_number: `PN-${index}`,
    quantity: index + 1,
    unit: "pcs",
  }));

  const recorder = recordTextCalls();
  let buffer;
  try {
    buffer = await generateGatePassPdf(baseGatePass(), items, "https://example.test/verify#token");
  } finally {
    recorder.restore();
  }

  assert.ok(Buffer.isBuffer(buffer));
  const pageCount = (buffer.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert.ok(pageCount >= 2, `expected multiple pages, saw ${pageCount}`);

  const headerOccurrences = recorder.calls.filter((call) => call.text === "Description").length;
  assert.ok(
    headerOccurrences >= 2,
    `expected the "Description" column header to be drawn once per page (>= 2 for ${pageCount} pages), saw ${headerOccurrences}`,
  );
});

test("intentionally long metadata values (destination, requester, driver, vehicle, department, remarks) wrap within their column instead of throwing or overlapping the QR code", async () => {
  const veryLong =
    "This is an intentionally very long value meant to exercise text wrapping inside a fixed-width column rather than overflowing into the adjacent QR code region of the printed Gate Pass document";
  const veryLongRemarks =
    "Remarks sit below the QR code block entirely, so they legitimately use the full page width rather than the QR-adjacent column — this is a distinct value so the width-constrained assertions below aren't accidentally satisfied by an unrelated row.";

  const gatePass = baseGatePass({
    issuing_department_name: veryLong,
    requested_by: veryLong,
    destination: veryLong,
    driver_name: veryLong,
    vehicle_registration: veryLong,
    remarks: veryLongRemarks,
  });

  const recorder = recordTextCalls();
  let buffer;
  try {
    buffer = await generateGatePassPdf(
      gatePass,
      [{ description: "Item", quantity: 1, unit: "pcs" }],
      "https://example.test/verify#token",
    );
  } finally {
    recorder.restore();
  }

  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 5).toString("ascii"), "%PDF-");

  // The fix: every long metadata value is drawn with an explicit width
  // clamp (the reserved left column, 250pt) rather than the page's full
  // remaining width — that's what keeps it from wrapping into the QR
  // code's own space instead of overlapping it.
  const longValueCalls = recorder.calls.filter((call) => call.text === veryLong);
  assert.ok(longValueCalls.length > 0, "expected the long metadata values to actually be drawn");
  for (const call of longValueCalls) {
    const options = call.args.find((arg) => arg && typeof arg === "object" && "width" in arg);
    assert.ok(options, `expected a width-constrained text() call, got args ${JSON.stringify(call.args)}`);
    assert.equal(options.width, 250);
  }

  // The QR caption must still have been drawn — the metadata column
  // growing taller (from wrapping) must not have thrown or skipped it.
  assert.ok(
    recorder.calls.some((call) => call.text === "Scan at the gate to verify"),
    "QR caption must still render",
  );

  // Remarks renders below the QR block entirely (no adjacency concern),
  // and a very long value there must still render without throwing.
  assert.ok(
    recorder.calls.some((call) => call.text === veryLongRemarks),
    "expected the long remarks value to be drawn",
  );
});
