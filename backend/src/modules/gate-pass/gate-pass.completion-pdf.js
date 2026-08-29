import PDFDocument from "pdfkit";
import { formatDate, formatDateTime } from "../../shared/time/app-timezone.js";

// The completion/closure document — deliberately NOT the approval PDF.
//
// The approval PDF answers "may this leave?" and carries a live QR for the
// gate. This one answers "what actually happened?": real exit and return
// times, who recorded them, and the photographic evidence from both
// directions in two clearly separated sections.
//
// Two things it must never do:
//   * carry Procurement pricing. A Gate Pass has no commercial fields and
//     none are joined in — the Guard-facing chain stays free of prices.
//   * present additional inbound evidence as an approved outbound item.
//     Those photos are rendered in their own labelled block, after the
//     approved list, so the document cannot be read as if the approved
//     scope had been widened after the fact.

const PAGE_MARGIN = 40;
const CONTENT_WIDTH = 515;

function collectPdfBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

function sectionTitle(doc, text) {
  ensureSpace(doc, 40);
  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a").text(text, PAGE_MARGIN, doc.y);
  doc.moveTo(PAGE_MARGIN, doc.y + 2).lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y + 2)
    .strokeColor("#cbd5e1").stroke();
  doc.moveDown(0.5);
}

function field(doc, label, value) {
  ensureSpace(doc, 34);
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#64748b").text(label, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.font("Helvetica").fontSize(10).fillColor("#0f172a").text(value || "—", { width: CONTENT_WIDTH });
  doc.moveDown(0.35);
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
}

// Photos are laid out two per row at a bounded width. Rendering the stored
// bytes at their natural size would make a 12-photo pass an unusable
// document (and an undeliverable WhatsApp attachment).
const PHOTO_WIDTH = 245;
const PHOTO_HEIGHT = 165;
const PHOTO_GAP = 25;

function drawPhotos(doc, photos) {
  if (!photos.length) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor("#64748b")
      .text("No photographic evidence was captured.", PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(0.5);
    return;
  }

  for (let index = 0; index < photos.length; index += 2) {
    const pair = photos.slice(index, index + 2);
    const captionHeight = 26;
    ensureSpace(doc, PHOTO_HEIGHT + captionHeight + 10);

    const rowY = doc.y;

    pair.forEach((photo, column) => {
      const x = PAGE_MARGIN + column * (PHOTO_WIDTH + PHOTO_GAP);
      try {
        doc.image(photo.buffer, x, rowY, { fit: [PHOTO_WIDTH, PHOTO_HEIGHT], align: "center" });
      } catch {
        // A single unreadable/corrupt stored image must never abort the whole
        // closure document — the record of the rest of the pass matters more.
        doc.font("Helvetica-Oblique").fontSize(8).fillColor("#b91c1c")
          .text("[photo could not be rendered]", x, rowY + 20, { width: PHOTO_WIDTH });
      }

      doc.font("Helvetica").fontSize(7).fillColor("#64748b").text(
        `${formatDateTime(photo.created_at)} · ${photo.captured_by_name}${photo.evidence_note ? ` · ${photo.evidence_note}` : ""}`,
        x,
        rowY + PHOTO_HEIGHT + 4,
        { width: PHOTO_WIDTH },
      );
    });

    doc.y = rowY + PHOTO_HEIGHT + captionHeight;
  }
}

export async function generateGatePassCompletionPdf(gatePass, items, evidence) {
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN });
  const bufferPromise = collectPdfBuffer(doc);

  doc.font("Helvetica-Bold").fontSize(18).fillColor("#0f172a").text("E-Set Digital Management System");
  doc.font("Helvetica").fontSize(12).fillColor("#475569").text("Gate Pass — Completion Record");
  doc.moveDown(0.6);
  doc.font("Helvetica-Bold").fontSize(14).fillColor("#0f172a").text(gatePass.gate_pass_number);
  doc.font("Helvetica").fontSize(10).fillColor("#475569").text(`Final status: ${gatePass.status}`);

  sectionTitle(doc, "Gate Pass");
  field(doc, "Site", gatePass.site_name);
  field(doc, "Issuing Department", gatePass.issuing_department_name);
  field(doc, "Requested By", gatePass.requested_by);
  field(doc, "Purpose", gatePass.purpose.replaceAll("_", " "));
  field(doc, "Destination", gatePass.destination);
  if (gatePass.job_order_id) field(doc, "Job Order ID", gatePass.job_order_id);
  field(doc, "Created", formatDateTime(gatePass.created_at));

  sectionTitle(doc, "Driver and Vehicle");
  field(doc, "Driver", `${gatePass.driver_name} (${gatePass.driver_phone})`);
  field(doc, "Vehicle Registration", gatePass.vehicle_registration);

  sectionTitle(doc, "Approval");
  field(doc, "Approved By", gatePass.approved_by_name);
  field(doc, "Approved At", gatePass.approved_at ? formatDateTime(gatePass.approved_at) : "—");
  if (gatePass.expected_return_date) {
    field(doc, "Expected Return Date", formatDate(gatePass.expected_return_date));
  }

  sectionTitle(doc, "Approved Items");
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#64748b");
  const headerY = doc.y;
  doc.text("Description", PAGE_MARGIN, headerY, { width: 240 });
  doc.text("Part Number", PAGE_MARGIN + 250, headerY, { width: 120 });
  doc.text("Qty", PAGE_MARGIN + 380, headerY, { width: 60 });
  doc.text("Unit", PAGE_MARGIN + 445, headerY, { width: 70 });
  doc.y = headerY + 14;

  doc.font("Helvetica").fontSize(9).fillColor("#0f172a");
  for (const item of items) {
    const cells = [
      { text: item.description, x: PAGE_MARGIN, width: 240 },
      { text: item.part_number || "—", x: PAGE_MARGIN + 250, width: 120 },
      { text: String(item.quantity), x: PAGE_MARGIN + 380, width: 60 },
      { text: item.unit || "—", x: PAGE_MARGIN + 445, width: 70 },
    ];
    const rowHeight = Math.max(...cells.map((cell) => doc.heightOfString(cell.text, { width: cell.width })));
    ensureSpace(doc, rowHeight + 6);
    const y = doc.y;
    for (const cell of cells) doc.text(cell.text, cell.x, y, { width: cell.width });
    doc.y = y + rowHeight + 6;
  }

  sectionTitle(doc, "Gate Movement");
  field(doc, "Actual Exit Time", gatePass.departure_at ? formatDateTime(gatePass.departure_at) : "—");
  field(doc, "Exit Recorded By", gatePass.departure_by_name);
  field(doc, "Actual Return / Entry Time", gatePass.return_at ? formatDateTime(gatePass.return_at) : "—");
  field(doc, "Return Recorded By", gatePass.return_by_name);
  if (gatePass.return_remarks) field(doc, "Return Remarks", gatePass.return_remarks);
  if (gatePass.remarks) field(doc, "Remarks", gatePass.remarks);

  const outbound = evidence.filter((photo) => photo.file_type === "DEPARTURE_PHOTO");
  const inbound = evidence.filter((photo) => photo.file_type === "RETURN_PHOTO");
  const additional = evidence.filter((photo) => photo.file_type === "RETURN_ADDITIONAL_PHOTO");

  doc.addPage();
  sectionTitle(doc, "OUTBOUND EVIDENCE");
  doc.font("Helvetica").fontSize(9).fillColor("#475569")
    .text(`${outbound.length} photo(s) captured at the gate when this Gate Pass exited.`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(0.5);
  drawPhotos(doc, outbound);

  sectionTitle(doc, "INBOUND / RETURN EVIDENCE");
  doc.font("Helvetica").fontSize(9).fillColor("#475569")
    .text(`${inbound.length} photo(s) captured at the gate on return / entry.`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(0.5);
  drawPhotos(doc, inbound);

  if (additional.length) {
    sectionTitle(doc, "Additional inbound evidence captured at gate");
    doc.font("Helvetica").fontSize(9).fillColor("#475569").text(
      "The following was photographed at the gate on entry but was NOT part of the approved "
        + "outbound item list above. It is recorded as independent gate evidence only and does not "
        + "form part of the approved Gate Pass.",
      PAGE_MARGIN,
      doc.y,
      { width: CONTENT_WIDTH },
    );
    doc.moveDown(0.5);
    drawPhotos(doc, additional);
  }

  doc.end();
  return bufferPromise;
}
