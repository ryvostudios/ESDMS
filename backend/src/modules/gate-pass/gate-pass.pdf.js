import PDFDocument from "pdfkit";
import QRCode from "qrcode";

function collectPdfBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

function row(doc, label, value) {
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#475569").text(label, { continued: false });
  doc.font("Helvetica").fontSize(11).fillColor("#0f172a").text(value || "—");
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

  const columnWidth = 250;
  const leftX = doc.x;
  const topY = doc.y;

  row(doc, "Date", new Date(gatePass.created_at).toLocaleDateString());
  row(doc, "Issuing Department", gatePass.issuing_department_name);
  row(doc, "Requested By", gatePass.requested_by);
  row(doc, "Issued To / Destination", gatePass.destination);
  row(doc, "Driver", `${gatePass.driver_name} (${gatePass.driver_phone})`);
  row(doc, "Vehicle Registration", gatePass.vehicle_registration);
  if (gatePass.job_order_id) row(doc, "Job Order ID", gatePass.job_order_id);
  row(doc, "Purpose", gatePass.purpose.replaceAll("_", " "));
  if (gatePass.expected_return_date) {
    row(doc, "Expected Return Date", new Date(gatePass.expected_return_date).toLocaleDateString());
  }

  doc.image(qrImage, leftX + columnWidth + 40, topY, { width: 160 });
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#64748b")
    .text("Scan at the gate to verify", leftX + columnWidth + 40, topY + 165, { width: 160, align: "center" });

  doc.moveDown(1);
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a").text("Items");
  doc.moveDown(0.3);

  const tableTop = doc.y;
  const cols = [40, 240, 340, 420, 480];

  doc.font("Helvetica-Bold").fontSize(9).fillColor("#475569");
  doc.text("Description", cols[0], tableTop);
  doc.text("Part Number", cols[1], tableTop);
  doc.text("Qty", cols[2], tableTop);
  doc.text("Unit", cols[3], tableTop);
  doc.moveDown(0.4);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor("#e2e8f0").stroke();
  doc.moveDown(0.3);

  doc.font("Helvetica").fontSize(9).fillColor("#0f172a");

  for (const item of items) {
    const y = doc.y;
    doc.text(item.description, cols[0], y, { width: 190 });
    doc.text(item.part_number || "—", cols[1], y, { width: 90 });
    doc.text(String(item.quantity), cols[2], y, { width: 70 });
    doc.text(item.unit || "—", cols[3], y, { width: 70 });
    doc.moveDown(0.6);
  }

  doc.moveDown(1);
  if (gatePass.remarks) {
    row(doc, "Remarks", gatePass.remarks);
  }

  doc.moveDown(0.5);
  row(doc, "Created By", gatePass.created_by_name);
  row(doc, "Approved By", gatePass.approved_by_name);
  row(doc, "Approved At", gatePass.approved_at ? new Date(gatePass.approved_at).toLocaleString() : "—");

  doc.end();

  return bufferPromise;
}
