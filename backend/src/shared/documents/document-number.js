// Server-controlled document numbering for IPO and Delivery Challan.
//
// Deliberately NOT a numbering engine. Issuance reuses the exact atomic
// year-keyed counter Gate Pass and Material Demand already use (INSERT ..
// ON CONFLICT DO UPDATE .. RETURNING, which row-locks the counter, so two
// concurrent generators serialize and can never receive the same value).
// The only thing added is that the *format* is data rather than a string
// literal, so prefix/separator/suffix/padding/starting number become
// configurable without touching business logic.
//
// The V1 default follows the authentic E-Set reference format:
//
//     ESET/2026/32
//
// Numbers are never client-supplied, never reused, and never recomputed:
// the formatted string is persisted on the document itself, so changing the
// settings later cannot restate an already-issued number. A cancelled
// document keeps its number and the counter is never rolled back.
import { currentYearInAppTimezone } from "../time/app-timezone.js";

export function formatDocumentNumber({ prefix, separator = "/", suffix, padWidth }, year, value) {
  const core = [prefix, year, String(value).padStart(padWidth, "0")].join(separator);
  return suffix ? `${core}${separator}${suffix}` : core;
}

// A document number is a business reference, not a filename: the authentic
// E-Set format contains "/", which must never reach a filesystem path, a
// Content-Disposition header, or a storage key unescaped. Every place that
// turns a number into a filename goes through here.
export function documentFilename(documentNumber, extension) {
  // Allowlist, not a blocklist, and dots are excluded from the base name
  // entirely: the only "." in the result is the one this function adds before
  // the extension, so no input can produce "..", a second extension, or a
  // quote/newline that would break the Content-Disposition header.
  const safe = String(documentNumber)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return `${safe || "document"}.${extension}`;
}

export async function findNumberSettings(client, documentType) {
  const result = await client.query(
    `SELECT document_type, prefix, separator, suffix, pad_width, start_value
     FROM document_number_settings WHERE document_type = $1`,
    [documentType],
  );
  return result.rows[0] || null;
}

export async function nextDocumentNumber(client, documentType) {
  const settings = await findNumberSettings(client, documentType);

  if (!settings) {
    throw new Error(`document-number: no numbering settings for ${documentType}`);
  }

  const year = currentYearInAppTimezone();
  // A year's first document starts at the configured start_value; every
  // later one increments. Lowering start_value later can therefore never
  // pull an existing year's counter backwards into already-issued numbers.
  const result = await client.query(
    `INSERT INTO document_number_counters (document_type, year, last_value)
     VALUES ($1, $2, $3)
     ON CONFLICT (document_type, year)
       DO UPDATE SET last_value = document_number_counters.last_value + 1
     RETURNING last_value`,
    [documentType, year, settings.start_value],
  );

  return formatDocumentNumber(
    {
      prefix: settings.prefix,
      separator: settings.separator,
      suffix: settings.suffix,
      padWidth: settings.pad_width,
    },
    year,
    result.rows[0].last_value,
  );
}
