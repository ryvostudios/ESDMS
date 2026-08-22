import { test } from "node:test";
import assert from "node:assert/strict";
import { generateGatePassPdf } from "../src/modules/gate-pass/gate-pass.pdf.js";

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

test("PDF generation handles enough items to force a page break", async () => {
  const items = Array.from({ length: 60 }, (_, index) => ({
    description: `Item ${index}`,
    part_number: `PN-${index}`,
    quantity: index + 1,
    unit: "pcs",
  }));

  const buffer = await generateGatePassPdf(baseGatePass(), items, "https://example.test/verify#token");

  assert.ok(Buffer.isBuffer(buffer));
  const pageCount = (buffer.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert.ok(pageCount >= 2, `expected multiple pages, saw ${pageCount}`);
});
