import { test } from "node:test";
import assert from "node:assert/strict";
import PDFDocument from "pdfkit";
import { generateGatePassPdf } from "../src/modules/gate-pass/gate-pass.pdf.js";
import { recordLayout } from "./pdf-layout-recorder.js";

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

// Realistic worst case: every free-text field near its validation maximum,
// several long items. Before the fix the metadata column ran past page 1
// and the QR clamp was then applied on page 2, drawing the items table on
// top of the driver/vehicle fields.
function longGatePass() {
  const repeat = (text, times) => Array.from({ length: times }, () => text).join(" ");
  return baseGatePass({
    issuing_department_name: repeat("Mechanical Maintenance and Heavy Equipment Department", 2),
    requested_by: repeat("Muhammad Abdullah Rehman Siddiqui", 4).slice(0, 150),
    destination: repeat("Lahore Repair Workshop Industrial Estate Phase", 4).slice(0, 200),
    driver_name: repeat("Chaudhry Muhammad Imran Khalid Mehmood", 3).slice(0, 150),
    vehicle_registration: "LES-4471-TRAILER-HEAVY-123456",
    job_order_id: "JO-2026-0000000000000000000000000000000000000001",
    purpose: "REPAIR_RECTIFICATION",
    expected_return_date: "2026-10-01",
    remarks: repeat("Handle with care, fragile components.", 30).slice(0, 1000),
    created_by_name: repeat("Creator Full Name", 5),
    approved_by_name: repeat("Approver Full Name", 5),
  });
}

const longItems = Array.from({ length: 8 }, (_, index) => ({
  description: Array.from({ length: 8 }, () => `Hydraulic pump assembly item ${index}`).join(" ").slice(0, 300),
  part_number: "PN-ABCDEFGHIJ ".repeat(7).trim().slice(0, 100),
  quantity: "1234567.25",
  unit: "cubic-metres-long-unit",
}));

test("approval PDF: long values in every field produce no overlapping or out-of-page text, across pages", async () => {
  const layout = recordLayout();
  try {
    await generateGatePassPdf(longGatePass(), longItems, "https://example.test/verify#token");
  } finally {
    layout.restore();
  }

  assert.ok(layout.pageCount() >= 2, "the long pass must actually exercise pagination");
  assert.deepEqual(layout.overlaps(), []);
  assert.deepEqual(layout.outOfBounds(), []);
  // Nothing is truncated to make it fit.
  assert.ok(layout.boxes.some((box) => box.text === longGatePass().remarks));
  assert.ok(layout.boxes.some((box) => box.text === longItems[7].description));
});

test("approval PDF: a Gate Pass with zero items prints 'No material items' instead of an empty table", async () => {
  const layout = recordLayout();
  try {
    await generateGatePassPdf(longGatePass(), [], "https://example.test/verify#token");
  } finally {
    layout.restore();
  }

  const drawn = layout.boxes.map((box) => box.text);
  assert.ok(drawn.includes("No material items"));
  assert.ok(!drawn.includes("Part Number"), "no orphan table header");
  assert.deepEqual(layout.overlaps(), []);
  assert.deepEqual(layout.outOfBounds(), []);
});
