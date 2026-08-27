import {
  COMPANY,
  createDocument,
  documentHeader,
  fieldGrid,
  partiesBlock,
  sectionTitle,
  signatureBlock,
  table,
  footer,
  formatDate,
  formatDateTime,
} from "../../shared/documents/pdf-layout.js";

// Follows the structure of the authentic modern E-Set Delivery Challan:
// FROM/TO, date and PO/IPO reference, the Demand subject line, the Sr#/Item/
// Description/Quantity/UOM table, the delivery confirmation statement, and
// the two representative signature blocks.
//
// A challan is a DELIVERY document, not a receipt: it is issued before the
// material arrives, so it never states that anything was received in good
// order. It provides the confirmation area the receiving party fills in.
//
// The printed Delivery Challan is deliberately a CLEAN OPERATIONAL document:
// what is being delivered, how much, to which department, against which IPO.
// It carries no approval history, no internal Procurement notes, no pricing
// and no price comparison. That is a schema fact as much as a template one —
// delivery_challan_lines has no price column at all — which is why the
// document is safe to share through the department's normal channels,
// including the WhatsApp group the business already uses.
//
// The owner also supplied an older, simpler challan; keeping the whole layout
// in this one file is what makes swapping between them a template change with
// no effect on DC data, numbering or workflow.
export async function generateDeliveryChallanPdf({ deliveryChallan, lines }) {
  const { doc, buffer } = createDocument();

  documentHeader(doc, {
    title: "Delivery Challan",
    reference: deliveryChallan.dc_number,
    // Issuance context only. The challan's later workflow status (RECEIVING,
    // COMPLETED) is deliberately absent so the issued document's meaning does
    // not drift after it has been printed and shared.
    subtitle:
      deliveryChallan.status === "DRAFT"
        ? "DRAFT — not yet finalized"
        : `Issued ${deliveryChallan.finalized_at ? formatDateTime(deliveryChallan.finalized_at) : "—"}`,
  });

  partiesBlock(doc, {
    from: `${COMPANY.name}\nProcurement Team`,
    to: `${deliveryChallan.department_name} Department\n${deliveryChallan.site_name}`,
  });

  fieldGrid(doc, [
    { label: "Delivery Challan #", value: deliveryChallan.dc_number },
    { label: "Date", value: formatDate(deliveryChallan.finalized_at || deliveryChallan.created_at) },
    { label: "IPO Reference", value: deliveryChallan.ipo_number },
    { label: "Demand Reference", value: deliveryChallan.demand_number },
    { label: "Department", value: deliveryChallan.department_name },
    { label: "Prepared By", value: deliveryChallan.created_by_name },
  ]);

  sectionTitle(doc, `Subject: Material delivery against ${deliveryChallan.ipo_number}`);
  table(
    doc,
    [
      { header: "Sr #", key: "line_no", width: 36 },
      { header: "Item / Description", key: "item_name_snapshot", width: 279 },
      { header: "Quantity", key: "quantity", width: 90, align: "right" },
      { header: "UOM", key: "uom_name_snapshot", width: 100 },
    ],
    lines,
  );

  if (deliveryChallan.note) {
    sectionTitle(doc, "Note");
    doc.font("Helvetica").fontSize(9).fillColor("#0f172a").text(deliveryChallan.note, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
    });
    doc.moveDown(1);
  }

  // A challan is issued BEFORE the material is received, so it must not assert
  // that receipt happened. It carries the confirmation area the authentic
  // E-Set sample uses, which the receiving party completes on delivery; the
  // authoritative receipt is recorded separately in ESDMS.
  sectionTitle(doc, "Receipt Confirmation (to be completed on delivery)");
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#475569")
    .text(
      "To be completed by the receiving department at the time of delivery. Record any shortage, damage or discrepancy below and in ESDMS.",
      doc.page.margins.left,
      doc.y,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right },
    );

  fieldGrid(doc, [
    { label: "Quantity Received", value: "" },
    { label: "Shortage / Damage / Remarks", value: "" },
    { label: "Received By (Name)", value: "" },
    { label: "Date Received", value: "" },
  ]);

  signatureBlock(doc, ["E-Set Representative", "Receiving / O&M Representative"]);

  footer(
    doc,
    `${COMPANY.footer} Receipt must also be recorded in ESDMS by the receiving department. This document is not a stock or inventory statement.`,
  );

  doc.end();
  return buffer;
}
