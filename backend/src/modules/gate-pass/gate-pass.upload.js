import multer from "multer";
import {
  ALLOWED_PHOTO_MIME_TYPES,
  MAX_EVIDENCE_PHOTO_BYTES,
  MAX_EVIDENCE_PHOTOS_PER_REQUEST,
} from "./gate-pass.constants.js";
import { ValidationError } from "../../shared/errors/app-error.js";
import { guardParsedBody } from "../../shared/http/text-safety.js";

const EXTENSION_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// A client-supplied Content-Type is just a claim — fileFilter below only
// screens on that claim (multer hasn't read the body yet at that point).
// The real check is here, against file signature bytes the client's own
// mimetype value cannot influence.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SIGNATURE_CHECKS = {
  "image/jpeg": (buffer) =>
    buffer.length > 4 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff &&
    buffer[buffer.length - 2] === 0xff &&
    buffer[buffer.length - 1] === 0xd9,
  "image/png": (buffer) =>
    buffer.length > 16 &&
    buffer.subarray(0, 8).equals(PNG_SIGNATURE) &&
    buffer.toString("ascii", 12, 16) === "IHDR",
  "image/webp": (buffer) =>
    buffer.length > 16 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(buffer.toString("ascii", 12, 16)),
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EVIDENCE_PHOTO_BYTES, files: MAX_EVIDENCE_PHOTOS_PER_REQUEST },
  fileFilter(req, file, callback) {
    if (!ALLOWED_PHOTO_MIME_TYPES.includes(file.mimetype)) {
      return callback(new ValidationError("Photo must be JPEG, PNG, or WebP."));
    }

    return callback(null, true);
  },
});

// Two field names, one handler: "photo" is the original single-file contract
// (still used by the existing Guard exit/return form), "photos" carries the
// multi-capture case. Accepting both means adding multi-photo support never
// breaks a client that already works.
// guardParsedBody: multer parses the multipart text fields (kind, note,
// odometer, remarks) long after the global text guard in app.js has run, so
// the same single definition is re-applied to them here — automatically for
// every route that uses this middleware.
export const evidencePhotoUpload = guardParsedBody(
  upload.fields([
    { name: "photo", maxCount: 1 },
    { name: "photos", maxCount: MAX_EVIDENCE_PHOTOS_PER_REQUEST },
  ]),
);

// Normalizes the multer file into the shape gate-pass.service expects,
// deriving the extension from the verified MIME type — never from the
// client-supplied original filename. Also re-validates the actual bytes
// against the declared type: fileFilter above only ever saw the client's
// claimed Content-Type, not the body.
function toVerifiedPhoto(file) {
  // fileFilter only ever saw the client's CLAIMED Content-Type; this is the
  // check against bytes the client cannot forge into a different format.
  if (!SIGNATURE_CHECKS[file.mimetype]?.(file.buffer)) {
    throw new ValidationError("The uploaded file is not a valid JPEG, PNG, or WebP image.");
  }

  return {
    buffer: file.buffer,
    mimeType: file.mimetype,
    extension: EXTENSION_BY_MIME[file.mimetype],
  };
}

// Every uploaded photo, in request order, from either field name. The first
// one is what exit/return store as the event's primary photo (the column the
// status-coherence CHECK requires); the rest are additional evidence rows.
export function extractPhotos(req) {
  const files = [...(req.files?.photo ?? []), ...(req.files?.photos ?? [])];
  return files.map(toVerifiedPhoto);
}

export function extractPhoto(req) {
  return extractPhotos(req)[0] ?? null;
}
