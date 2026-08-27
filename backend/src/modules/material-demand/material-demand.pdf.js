import {
  COMPANY,
  createDocument,
  documentHeader,
  fieldGrid,
  sectionTitle,
  table,
  footer,
  formatDate,
  formatDateTime,
} from "../../shared/documents/pdf-layout.js";

// The Demand List PDF carries NO pricing, for any viewer, ever — not even for
// an actor who does hold financial authority. One unpriced representation is
// deliberate: it removes the possibility of this endpoint becoming a
// financial-authorization bypass, and the priced document already exists as
// the IPO PDF, gated on commercial authority (spec §36, §38 of the build
// prompt). Approval REASONS are also omitted: a FINAL rejection reason is
// protected commercial context (see material-demand.service.js).
export async function generateDemandListPdf({ demand, lines, approvals }) {
  const { doc, buffer } = createDocument();

  documentHeader(doc, {
    title: "Material Demand List",
    reference: demand.demand_number,
    subtitle: `Revision ${demand.revision}`,
  });

  fieldGrid(doc, [
    { label: "Department", value: demand.department_name },
    { label: "Site", value: demand.site_name },
    { label: "Created By", value: demand.created_by_name },
    { label: "Date", value: formatDate(demand.created_at) },
    { label: "Submitted", value: demand.submitted_at ? formatDateTime(demand.submitted_at) : null },
    { label: "Status", value: demand.status.replaceAll("_", " ") },
  ]);

  sectionTitle(doc, "Requested Materials");
  table(
    doc,
    [
      { header: "#", key: "line_no", width: 30 },
      { header: "Material", key: "item_name_snapshot", width: 245 },
      { header: "Unit", key: "uom_name_snapshot", width: 100 },
      { header: "Requested Qty", key: "requested_quantity", width: 90, align: "right" },
      { header: "Note", key: "note", width: 50 },
    ],
    lines,
  );

  if (approvals.length > 0) {
    sectionTitle(doc, "Approval History");
    table(
      doc,
      [
        { header: "Stage", key: "stage", width: 80 },
        { header: "Responsibility", key: "responsibility", width: 150 },
        { header: "Decision", key: "decision", width: 100 },
        { header: "By", key: "actor_name", width: 125 },
        { header: "When", key: "when", width: 60 },
      ],
      approvals.map((approval) => ({
        stage: approval.approval_stage,
        responsibility: approval.approval_type === "MANAGEMENT_REVIEW" ? "Management Review" : "Formal Approval",
        decision: approval.decision,
        actor_name: approval.actor_name,
        when: formatDate(approval.created_at),
      })),
    );
  }

  if (demand.note) {
    sectionTitle(doc, "Note");
    doc.font("Helvetica").fontSize(9).fillColor("#0f172a").text(demand.note, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
    });
  }

  footer(
    doc,
    `${COMPANY.footer} Requested quantities only. This document records a material request and its approvals; it is not a purchase order and not a stock statement.`,
  );

  doc.end();
  return buffer;
}
