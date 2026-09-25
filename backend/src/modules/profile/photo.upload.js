import multer from "multer";
import { flatMultipartLimits } from "../../shared/http/multipart-limits.js";
import { ValidationError } from "../../shared/errors/app-error.js";
import { guardParsedBody } from "../../shared/http/text-safety.js";

// Deliberately parallel to gate-pass.upload.js rather than a shared import
// — see docs/DECISIONS.md on why Gate Pass code is not touched to enable
// reuse here. Same signature-based validation approach and size ceiling
// class (photo uploads), independently maintained per module boundary
// conventions (docs/MODULES.md §13).
const ALLOWED_PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const EXTENSION_BY_MIME = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SIGNATURE_CHECKS = {
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
  limits: flatMultipartLimits({ fileSize: MAX_PHOTO_BYTES, fields: 0, fieldSize: 0, fieldNameSize: 5 }),
  fileFilter(req, file, callback) {
    if (!ALLOWED_PHOTO_MIME_TYPES.includes(file.mimetype)) {
      return callback(new ValidationError("Photo must be JPEG, PNG, or WebP."));
    }
    return callback(null, true);
  },
});

export const profilePhotoUpload = guardParsedBody(upload.single("photo"));

export function extractPhoto(req) {
  if (!req.file) throw new ValidationError("No photo file was provided.");

  const isRealImage = SIGNATURE_CHECKS[req.file.mimetype]?.(req.file.buffer);
  if (!isRealImage) throw new ValidationError("The uploaded file is not a valid JPEG, PNG, or WebP image.");

  return {
    buffer: req.file.buffer,
    mimeType: req.file.mimetype,
    extension: EXTENSION_BY_MIME[req.file.mimetype],
  };
}
