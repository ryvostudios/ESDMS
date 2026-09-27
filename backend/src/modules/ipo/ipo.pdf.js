import { loadDocumentBranding } from "../../shared/documents/branding.js";
import {
  createDocument,
  documentHeader,
  fieldGrid,
  partiesBlock,
  sectionTitle,
  signatureBlock,
  table,
  totalsRow,
  footer,
  formatDate,
  formatDateTime,
} from "../../shared/documents/pdf-layout.js";

// Presentation only, following the structure of the authentic E-Set
// "Internal Purchase Order" the owner supplied: FROM/TO, the reference block
// (IPO #, IPO date, Ref. CPO #, fulfil-by, budget), the Demand subject, the
// item table with description/quantity/UOM/unit price/total, the grand total,
// and the two management/procurement signature blocks.
//
// Every value arrives already authorized and already snapshotted by the
// service; this template invents nothing, reads nothing from the database,
// and holds no business rules. When the owner supplies the authentic
// letterhead artwork, only this file changes — the IPO's data, schema, number
// and history are untouched by a layout change (spec §35, §37).
//
// This document is the APPROVED PURCHASING AUTHORITY, so it contains only the
// approved snapshot: quantities, unit prices, totals, budget and approval
// references. Downstream purchasing progress (how much has since been bought,
// the IPO's current workflow status) is deliberately absent — those change
// after issuance, and a document whose meaning drifts is not an authority.
// Progress lives in the application, where it belongs.
//
// Fields the real sample shows but ESDMS has no authoritative source for yet
// (Inquiry #, Ref. CPO #, Fulfil By, per-item Brand/Specs) are rendered from
// real data where it exists and left blank otherwise. They are never invented
// to make the page look complete.
// `branding` is resolved centrally when not supplied (tests pass it).
export async function generateIpoPdf({ ipo, lines, approvals }, branding) {
  const brand = branding ?? (await loadDocumentBranding());
  const { doc, buffer } = createDocument();

  documentHeader(doc, {
    branding: brand,
    title: "Internal Purchase Order",
    reference: ipo.ipo_number,
    subtitle: `Generated ${formatDateTime(ipo.generated_at)} · ${brand.system}`,
  });

  partiesBlock(doc, {
    from: `${brand.companyName}\n${ipo.department_name} Department\n${ipo.site_name}`,
    to: "Procurement Team",
  });

  fieldGrid(doc, [
    { label: "IPO #", value: ipo.ipo_number },
    { label: "IPO Date", value: formatDate(ipo.generated_at) },
    { label: "Demand Reference", value: `${ipo.demand_number} (revision ${ipo.demand_revision})` },
    { label: "Department", value: ipo.department_name },
    { label: "Site", value: ipo.site_name },
    { label: "Budget Currency", value: ipo.currency },
    { label: "Approved Budget", value: `${ipo.currency} ${ipo.estimated_total}` },
  ]);

  sectionTitle(doc, `Subject: Approved materials for Demand ${ipo.demand_number}`);
  table(
    doc,
    [
      // Exactly the authentic E-Set sample's item table, and nothing that can
      // move after issuance. `purchased_quantity` is present in the projection
      // because the Procurement screens need it — the document simply never
      // renders it.
      // Widths total the 515pt usable between A4's 40pt margins; the space the
      // removed column freed goes to the money columns, which the authentic
      // sample gives room to.
      { header: "Sr #", key: "line_no", width: 36 },
      { header: "Item / Description", key: "item_name_snapshot", width: 195 },
      { header: "Qty", key: "approved_quantity", width: 64, align: "right" },
      { header: "UOM", key: "uom_code_snapshot", width: 50 },
      { header: "Unit Price", key: "estimated_unit_price", width: 82, align: "right" },
      { header: "Total Price", key: "estimated_line_total", width: 88, align: "right" },
    ],
    lines,
  );

  totalsRow(doc, `Grand Total (${ipo.currency})`, ipo.estimated_total);

  if (approvals.length > 0) {
    sectionTitle(doc, "Approved By");
    fieldGrid(
      doc,
      approvals.map((approval) => ({
        label: approval.approval_type === "MANAGEMENT_REVIEW" ? "Management Review" : "Formal / CFO Approval",
        value: `${approval.actor_name} — ${formatDateTime(approval.created_at)}`,
      })),
    );
  }

  if (ipo.status === "CANCELLED") {
    sectionTitle(doc, "Cancelled");
    fieldGrid(doc, [
      { label: "Cancelled By", value: ipo.cancelled_by_name },
      { label: "Cancelled At", value: ipo.cancelled_at ? formatDateTime(ipo.cancelled_at) : null },
      { label: "Category", value: ipo.cancellation_category },
      { label: "Reason", value: ipo.cancellation_reason },
    ]);
  }

  signatureBlock(doc, ["E-Set Management Representative", "Procurement Team Representative"]);

  footer(
    doc,
    `${brand.footer} Confidential — contains commercial information. This document records approved purchasing authority only; it is not a stock or inventory statement.`,
  );

  doc.end();
  return buffer;
}
