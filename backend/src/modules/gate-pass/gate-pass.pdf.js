import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { formatDate, formatDateTime } from "../../shared/time/app-timezone.js";

function collectPdfBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

function row(doc, label, value, { width } = {}) {
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#475569").text(label, { continued: false, width });
  doc.font("Helvetica").fontSize(11).fillColor("#0f172a").text(value || "—", { width });
  doc.moveDown(0.6);
}

export async function generateGatePassPdf(gatePass, items, verificationUrl) {
  const qrDataUrl = await QRCode.toDataURL(verificationUrl, { margin: 1, width: 220 });
  const qrImage = Buffer.from(qrDataUrl.split(",")[1], "base64");

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const bufferPromise = collectPdfBuffer(doc);

  doc.font("Helvetica-Bold").fontSize(18).fillColor("#0f172a").text("E-Set Digital Management System");
  doc.font("Helvetica").fontSize(12).fillColor("#475569").text("Gate Pass");
  doc.moveDown(1);

  doc.font("Helvetica-Bold").fontSize(14).fillColor("#0f172a").text(gatePass.gate_pass_number);
  doc.moveDown(1);

  // Reserved rectangle for the QR code — metadata text is clamped to
  // columnWidth so a long value (destination, remarks-length driver name,
  // etc.) wraps within its own column instead of running rightward into
  // the QR's space.
  const columnWidth = 250;
  const leftX = doc.x;
  const topY = doc.y;
  const qrSize = 160;
  const qrCaptionHeight = 20;
  const qrBlockBottom = topY + qrSize + qrCaptionHeight;

  row(doc, "Date", formatDate(gatePass.created_at), { width: columnWidth });
  row(doc, "Issuing Department", gatePass.issuing_department_name, { width: columnWidth });
  row(doc, "Requested By", gatePass.requested_by, { width: columnWidth });
  row(doc, "Issued To / Destination", gatePass.destination, { width: columnWidth });
  row(doc, "Driver", `${gatePass.driver_name} (${gatePass.driver_phone})`, { width: columnWidth });
  row(doc, "Vehicle Registration", gatePass.vehicle_registration, { width: columnWidth });
  if (gatePass.job_order_id) row(doc, "Job Order ID", gatePass.job_order_id, { width: columnWidth });
  row(doc, "Purpose", gatePass.purpose.replaceAll("_", " "), { width: columnWidth });
  if (gatePass.expected_return_date) {
    row(doc, "Expected Return Date", formatDate(gatePass.expected_return_date), { width: columnWidth });
  }

  doc.image(qrImage, leftX + columnWidth + 40, topY, { width: qrSize });
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#64748b")
    .text("Scan at the gate to verify", leftX + columnWidth + 40, topY + qrSize + 5, {
      width: qrSize,
      align: "center",
    });

  // Continue below whichever block is taller — the (now width-clamped,
  // correctly wrapping) metadata column, or the fixed-height QR block —
  // so short metadata never lets later content start inside the QR's own
  // footprint.
  doc.y = Math.max(doc.y, qrBlockBottom);

  doc.moveDown(1);

  const cols = [40, 240, 340, 420, 480];

  function drawTableHeader() {
    const headerY = doc.y;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#475569");
    doc.text("Description", cols[0], headerY);
    doc.text("Part Number", cols[1], headerY);
    doc.text("Qty", cols[2], headerY);
    doc.text("Unit", cols[3], headerY);
    doc.moveDown(0.4);
    doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor("#e2e8f0").stroke();
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9).fillColor("#0f172a");
  }

  doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a").text("Items");
  doc.moveDown(0.3);
  drawTableHeader();

  const rowGap = 6;

  for (const item of items) {
    const cells = [
      { text: item.description, x: cols[0], width: 190 },
      { text: item.part_number || "—", x: cols[1], width: 90 },
      { text: String(item.quantity), x: cols[2], width: 70 },
      { text: item.unit || "—", x: cols[3], width: 70 },
    ];
    // Row height follows the tallest wrapped cell (long descriptions/part
    // numbers wrap to multiple lines) instead of a fixed moveDown, which
    // otherwise lets a wrapped cell overlap the next row.
    const rowHeight = Math.max(...cells.map((cell) => doc.heightOfString(cell.text, { width: cell.width })));

    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      drawTableHeader();
    }

    const y = doc.y;
    for (const cell of cells) {
      doc.text(cell.text, cell.x, y, { width: cell.width });
    }
    doc.y = y + rowHeight + rowGap;
  }

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
