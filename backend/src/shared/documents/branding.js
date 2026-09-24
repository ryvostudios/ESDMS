import fs from "node:fs";
import pool from "../../config/database.js";
import { storageService, verifyChecksum } from "../storage/storage-service.js";
import { logServerError } from "../logging/safe-logger.js";

// Company identity for NEWLY generated documents, resolved in one place from
// the CMS branding settings. A caller can never supply it: a business document
// must never be able to claim a different issuer than the system it came from.
//
// Issued documents are unaffected by later changes: Gate Pass, IPO and
// Delivery Challan PDFs are persisted once and served as stored bytes. See
// docs/CMS.md "Document branding".

export const DEFAULT_BRANDING = Object.freeze({
  companyName: "E-Set Engineering Services",
  system: "E-Set Digital Management System",
  contactDetails: "",
});

// The real E-Set logo (company-supplied eset-logo-header.png, transparent margin
// trimmed, pixels untouched), bundled with the application.
const DEFAULT_LOGO_URL = new URL("../../../assets/branding/eset-logo.png", import.meta.url);
let defaultLogo;

export function defaultLogoBytes() {
  if (defaultLogo === undefined) {
    try {
      defaultLogo = fs.readFileSync(DEFAULT_LOGO_URL);
    } catch (error) {
      logServerError(error, undefined, { operation: "branding.default-logo.read" });
      defaultLogo = null;
    }
  }
  return defaultLogo;
}

// The company.logo setting is written only by the CMS logo endpoints. '' is
// the bundled default; anything unparseable is treated as absent.
export function parseLogoReference(value) {
  if (!value) return null;
  try {
    const reference = JSON.parse(value);
    return typeof reference?.storageKey === "string" && /^[a-f0-9]{64}$/.test(reference.sha256 ?? "") ? reference : null;
  } catch {
    return null;
  }
}

async function configuredLogo(reference) {
  if (!reference) return defaultLogoBytes();
  try {
    const bytes = await storageService.read(reference.storageKey);
    if (verifyChecksum(bytes, reference.sha256)) return bytes;
    logServerError(new Error("Branding logo checksum mismatch."), undefined, { operation: "branding.logo.verify" });
  } catch (error) {
    logServerError(error, undefined, { operation: "branding.logo.read" });
  }
  // Never substitute a different logo for the one the company configured:
  // the document falls back to text identity instead.
  return null;
}

// Never throws: optional branding must not block a business document.
export async function loadDocumentBranding(executor = pool) {
  let values = {};
  try {
    const { rows } = await executor.query(
      "SELECT key, value FROM cms_settings WHERE key IN ('document.company_name','company.contact_details','company.logo')",
    );
    values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  } catch (error) {
    logServerError(error, undefined, { operation: "branding.settings.read" });
  }

  const companyName = values["document.company_name"]?.trim() || DEFAULT_BRANDING.companyName;
  return {
    companyName,
    system: DEFAULT_BRANDING.system,
    contactDetails: values["company.contact_details"]?.trim() || "",
    footer: `${companyName} · This is a system-generated document.`,
    logo: await configuredLogo(parseLogoReference(values["company.logo"])),
  };
}

const LOGO_MAX_WIDTH = 120;
const LOGO_HEIGHT = 46;
const GAP = 12;

// Logo (aspect ratio preserved, never stretched) beside the issuer name,
// document title and optional contact line. Every text block is width-clamped
// and the header ends below whichever column is taller, so long values wrap
// instead of colliding with the logo or the content that follows.
export function drawBrandHeader(doc, branding, { title }) {
  const left = doc.page.margins.left;
  const usable = doc.page.width - left - doc.page.margins.right;
  const top = doc.y;
  let textX = left;
  let logoBottom = top;

  if (branding.logo) {
    try {
      const image = doc.openImage(branding.logo);
      const width = Math.min(LOGO_MAX_WIDTH, (LOGO_HEIGHT * image.width) / image.height);
      const height = (width * image.height) / image.width;
      doc.image(image, left, top, { width, height });
      textX = left + width + GAP;
      logoBottom = top + height;
    } catch (error) {
      logServerError(error, undefined, { operation: "branding.logo.render" });
    }
  }

  const width = usable - (textX - left);
  doc.font("Helvetica-Bold").fontSize(15).fillColor("#0f172a").text(branding.companyName, textX, top + 2, { width });
  doc.font("Helvetica").fontSize(11).fillColor("#475569").text(title, textX, doc.y, { width });
  if (branding.contactDetails) {
    doc.font("Helvetica").fontSize(8).fillColor("#64748b").text(branding.contactDetails, textX, doc.y + 2, { width });
  }

  doc.x = left;
  doc.y = Math.max(logoBottom, doc.y) + 14;
}
