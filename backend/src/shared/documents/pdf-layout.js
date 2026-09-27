import PDFDocument from "pdfkit";
import { formatDate, formatDateTime } from "../time/app-timezone.js";
import { drawBrandHeader } from "./branding.js";

// Presentation primitives shared by every Procurement/Receiving PDF
// template. Business/workflow code never touches pdfkit directly: a service
// hands a template a plain authoritative data object, the template arranges
// it with these helpers. That is what makes the visual layout replaceable
// when the owner supplies the authentic E-Set IPO/DC artwork — the exchange
// is the data object, not the drawing code.
//
// Gate Pass keeps its own bespoke QR-and-column layout (gate-pass.pdf.js);
// it shares only the brand header (branding.js) with these templates.

const INK = "#0f172a";
const MUTED = "#475569";
const FAINT = "#94a3b8";
const RULE = "#e2e8f0";

export function createDocument() {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const buffer = new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  return { doc, buffer };
}

// Issuer identity (logo, company name, contact line) comes from the central
// document branding — see branding.js — never from a per-document field a
// caller could forge.
export function documentHeader(doc, { title, reference, subtitle, branding }) {
  drawBrandHeader(doc, branding, { title });
  doc.font("Helvetica-Bold").fontSize(14).fillColor(INK).text(reference);
  if (subtitle) {
    doc.font("Helvetica").fontSize(9).fillColor(FAINT).text(subtitle);
  }
  doc.moveDown(0.8);
}

// FROM / TO block, as the authentic E-Set documents present it.
export function partiesBlock(doc, { from, to }) {
  const startX = doc.page.margins.left;
  const columnWidth = 250;
  const y = doc.y;

  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("FROM", startX, y, { width: columnWidth });
  doc.font("Helvetica").fontSize(10).fillColor(INK).text(from, startX, doc.y, { width: columnWidth });
  const leftBottom = doc.y;

  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("TO", startX + columnWidth + 15, y, {
    width: columnWidth,
  });
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(INK)
    .text(to, startX + columnWidth + 15, doc.y, { width: columnWidth });

  doc.x = startX;
  doc.y = Math.max(leftBottom, doc.y) + 14;
}

// Signature panel: printed documents are signed by hand on site, so the
// blocks are drawn as ruled space, not as claimed signatures.
export function signatureBlock(doc, roles) {
  const startX = doc.page.margins.left;
  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const columnWidth = usable / roles.length;

  doc.moveDown(2);
  const y = doc.y;

  roles.forEach((role, index) => {
    const x = startX + index * columnWidth;
    doc
      .moveTo(x, y)
      .lineTo(x + columnWidth - 20, y)
      .strokeColor(RULE)
      .stroke();
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text(role, x, y + 6, { width: columnWidth - 20 });
  });

  doc.x = startX;
  doc.y = y + 32;
}

export function fieldGrid(doc, fields, { columns = 2, columnWidth = 250 } = {}) {
  const startX = doc.page.margins.left;
  let y = doc.y;
  let rowHeight = 0;

  fields.forEach((field, index) => {
    const column = index % columns;
    const x = startX + column * (columnWidth + 15);

    if (column === 0 && index > 0) {
      y += rowHeight + 10;
      rowHeight = 0;
    }

    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text(field.label, x, y, { width: columnWidth });
    const valueY = doc.y;
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(INK)
      .text(field.value === null || field.value === undefined || field.value === "" ? "—" : String(field.value), x, valueY, {
        width: columnWidth,
      });
    rowHeight = Math.max(rowHeight, doc.y - y);
  });

  doc.x = startX;
  doc.y = y + rowHeight + 14;
}

export function sectionTitle(doc, title) {
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(title, doc.page.margins.left, doc.y);
  doc.moveDown(0.3);
}

// Columns: [{ header, key, width, align }]. Row height follows the tallest
// wrapped cell so a long item name can never overlap the next row, and the
// header is redrawn after every page break.
export function table(doc, columns, rows) {
  const startX = doc.page.margins.left;

  function drawHeader() {
    const y = doc.y;
    let x = startX;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
    for (const column of columns) {
      doc.text(column.header, x, y, { width: column.width, align: column.align || "left" });
      x += column.width;
    }
    doc.y = y + 12;
    doc
      .moveTo(startX, doc.y)
      .lineTo(startX + columns.reduce((total, column) => total + column.width, 0), doc.y)
      .strokeColor(RULE)
      .stroke();
    doc.y += 5;
  }

  drawHeader();
  doc.font("Helvetica").fontSize(9).fillColor(INK);

  for (const row of rows) {
    const cells = columns.map((column) => ({
      column,
      text: row[column.key] === null || row[column.key] === undefined || row[column.key] === "" ? "—" : String(row[column.key]),
    }));
    const height = Math.max(
      ...cells.map((cell) => doc.heightOfString(cell.text, { width: cell.column.width - 6 })),
    );

    if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      drawHeader();
      doc.font("Helvetica").fontSize(9).fillColor(INK);
    }

    const y = doc.y;
    let x = startX;
    for (const cell of cells) {
      doc.text(cell.text, x, y, { width: cell.column.width - 6, align: cell.column.align || "left" });
      x += cell.column.width;
    }
    doc.y = y + height + 6;
  }

  doc.x = startX;
  doc.moveDown(0.8);
}

export function totalsRow(doc, label, value) {
  doc.font("Helvetica-Bold").fontSize(10).fillColor(INK);
  doc.text(`${label}: ${value}`, doc.page.margins.left, doc.y, {
    width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
    align: "right",
  });
  doc.moveDown(0.8);
}

export function footer(doc, note) {
  doc.moveDown(0.5);
  doc.font("Helvetica").fontSize(7).fillColor(FAINT).text(note, doc.page.margins.left, doc.y, {
    width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
  });
}

export { formatDate, formatDateTime };
