import multer from "multer";
import { flatMultipartLimits } from "../../shared/http/multipart-limits.js";
import { ValidationError } from "../../shared/errors/app-error.js";
import { guardParsedBody } from "../../shared/http/text-safety.js";

// Signature-based validation, same approach as gate-pass.upload.js and
// profile/photo.upload.js — a client-supplied Content-Type is only ever a
// claim; independently maintained per module boundary conventions rather
// than shared, see docs/DECISIONS.md. PDF added here since employee
// documents (CV, degree, license) are commonly PDFs, unlike Gate Pass
// evidence/profile photos which are always images.
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const EXTENSION_BY_MIME = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF_SIGNATURE = Buffer.from("%PDF-", "ascii");

const SIGNATURE_CHECKS = {
  "application/pdf": (buffer) => buffer.length > 5 && buffer.subarray(0, 5).equals(PDF_SIGNATURE),
  "image/jpeg": (buffer) =>
    buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9,
  "image/png": (buffer) => buffer.length > 16 && buffer.subarray(0, 8).equals(PNG_SIGNATURE) && buffer.toString("ascii", 12, 16) === "IHDR",
  "image/webp": (buffer) =>
    buffer.length > 16 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(buffer.toString("ascii", 12, 16)),
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: flatMultipartLimits({ fileSize: MAX_DOCUMENT_BYTES, fields: 2, fieldSize: 37, fieldNameSize: 14 }),
  fileFilter(req, file, callback) {
    if (!SIGNATURE_CHECKS[file.mimetype]) {
      return callback(new ValidationError("Unsupported file type."));
    }
    return callback(null, true);
  },
});

export const documentUpload = guardParsedBody(upload.single("file"));

// `allowedMimeTypes` is the specific document type's own configured
// allowlist (workforce-config) — narrower than "every type this endpoint
// can physically accept."
export function extractDocumentFile(req, allowedMimeTypes) {
  if (!req.file) throw new ValidationError("No file was provided.");

  if (!allowedMimeTypes.includes(req.file.mimetype)) {
    throw new ValidationError(`This document type only accepts: ${allowedMimeTypes.join(", ")}.`);
  }

  if (!SIGNATURE_CHECKS[req.file.mimetype]?.(req.file.buffer)) {
    throw new ValidationError("The uploaded file's content does not match its declared type.");
  }

  return {
    buffer: req.file.buffer,
    mimeType: req.file.mimetype,
    extension: EXTENSION_BY_MIME[req.file.mimetype],
    // Metadata only — the real storage key is always server-generated
    // (storage-service.js), so this can never cause path traversal; still
    // stripped of control characters and truncated to the column width.
    originalFilename: req.file.originalname.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 255) || null,
  };
}
