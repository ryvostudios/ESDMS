import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { formatDate, formatDateTime } from "../../shared/time/app-timezone.js";
import { drawBrandHeader, loadDocumentBranding } from "../../shared/documents/branding.js";

function collectPdfBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

const PAGE_MARGIN = 40;
const CONTENT_WIDTH = 515;

// Starts a new page when the next block would not fit. Every block is
// measured before it is drawn, so nothing relies on pdfkit's implicit
// mid-text page break (which would continue a field on the next page at
// coordinates computed for the previous one).
export function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
}

function row(doc, label, value, { x = PAGE_MARGIN, width = CONTENT_WIDTH } = {}) {
  const text = value === null || value === undefined || value === "" ? "—" : String(value);
  doc.font("Helvetica-Bold").fontSize(9);
  const labelHeight = doc.heightOfString(label, { width });
  doc.font("Helvetica").fontSize(11);
  ensureSpace(doc, labelHeight + doc.heightOfString(text, { width }));

  doc.font("Helvetica-Bold").fontSize(9).fillColor("#475569").text(label, x, doc.y, { width });
  doc.font("Helvetica").fontSize(11).fillColor("#0f172a").text(text, x, doc.y, { width });
  doc.moveDown(0.6);
}

// Shared by the approval and completion documents. Row height follows the
// tallest wrapped cell, the header is repeated after every page break, and
// a pass with no material items says so instead of printing an empty table.
export function drawItemsTable(doc, items) {
  const columns = [
    { header: "Description", width: 240 },
    { header: "Part Number", width: 130 },
    { header: "Qty", width: 65 },
    { header: "Unit", width: 80 },
  ];
  const gutter = 8;

  function drawHeader() {
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#475569");
    ensureSpace(doc, 40);
    const y = doc.y;
    let x = PAGE_MARGIN;
    for (const column of columns) {
      doc.text(column.header, x, y, { width: column.width - gutter });
      x += column.width;
    }
    doc.y = y + 14;
    doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y).strokeColor("#e2e8f0").stroke();
    doc.y += 5;
    doc.font("Helvetica").fontSize(9).fillColor("#0f172a");
  }

  if (!items.length) {
    ensureSpace(doc, 20);
    doc.font("Helvetica-Oblique").fontSize(10).fillColor("#475569")
      .text("No material items", PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(0.5);
    return;
  }

  drawHeader();

  for (const item of items) {
    const values = [item.description, item.part_number || "—", String(item.quantity), item.unit || "—"];
    const rowHeight = Math.max(
      ...values.map((text, index) => doc.heightOfString(text, { width: columns[index].width - gutter })),
    );

    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      drawHeader();
    }

    const y = doc.y;
    let x = PAGE_MARGIN;
    values.forEach((text, index) => {
      doc.text(text, x, y, { width: columns[index].width - gutter });
      x += columns[index].width;
    });
    doc.y = y + rowHeight + 6;
  }
}

// `branding` is resolved centrally when not supplied (tests pass it).
export async function generateGatePassPdf(gatePass, items, verificationUrl, branding) {
  const brand = branding ?? (await loadDocumentBranding());
  const qrDataUrl = await QRCode.toDataURL(verificationUrl, { margin: 1, width: 220 });
  const qrImage = Buffer.from(qrDataUrl.split(",")[1], "base64");

  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN });
  const bufferPromise = collectPdfBuffer(doc);

  drawBrandHeader(doc, brand, { title: "Gate Pass" });

  doc.font("Helvetica-Bold").fontSize(14).fillColor("#0f172a").text(gatePass.gate_pass_number);
  doc.moveDown(1);

  // Reserved rectangle for the QR code — metadata text is clamped to
  // columnWidth so a long value wraps within its own column instead of
  // running rightward into the QR's space.
  const columnWidth = 250;
  const topY = doc.y;
  const qrPage = doc.page;
  const qrX = PAGE_MARGIN + columnWidth + 40;
  const qrSize = 160;
  const qrBlockBottom = topY + qrSize + 20;

  doc.image(qrImage, qrX, topY, { width: qrSize });
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#64748b")
    .text("Scan at the gate to verify", qrX, topY + qrSize + 5, { width: qrSize, align: "center" });
  doc.y = topY;

  const meta = { width: columnWidth };
  row(doc, "Date", formatDate(gatePass.created_at), meta);
  row(doc, "Issuing Department", gatePass.issuing_department_name, meta);
  row(doc, "Requested By", gatePass.requested_by, meta);
  row(doc, "Issued To / Destination", gatePass.destination, meta);
  row(doc, "Driver", `${gatePass.driver_name} (${gatePass.driver_phone})`, meta);
  row(doc, "Vehicle Registration", gatePass.vehicle_registration, meta);
  if (gatePass.job_order_id) row(doc, "Job Order ID", gatePass.job_order_id, meta);
  row(doc, "Purpose", gatePass.purpose.replaceAll("_", " "), meta);
  if (gatePass.expected_return_date) {
    row(doc, "Expected Return Date", formatDate(gatePass.expected_return_date), meta);
  }

  // Continue below whichever block is taller. The QR clamp only applies
  // while still on the QR's page — on a continuation page its coordinates
  // mean nothing.
  if (doc.page === qrPage) doc.y = Math.max(doc.y, qrBlockBottom);

  doc.moveDown(1);
  ensureSpace(doc, 60);
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a").text("Items", PAGE_MARGIN, doc.y);
  doc.moveDown(0.3);
  drawItemsTable(doc, items);

  doc.moveDown(1);
  if (gatePass.remarks) {
    row(doc, "Remarks", gatePass.remarks);
  }

  doc.moveDown(0.5);
  row(doc, "Created By", gatePass.created_by_name);
  row(doc, "Approved By", gatePass.approved_by_name);
  row(doc, "Approved At", gatePass.approved_at ? formatDateTime(gatePass.approved_at) : "—");

  doc.end();

  return bufferPromise;
}
