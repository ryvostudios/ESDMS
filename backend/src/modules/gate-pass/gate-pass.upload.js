import multer from "multer";
import { ALLOWED_PHOTO_MIME_TYPES, MAX_EVIDENCE_PHOTO_BYTES } from "./gate-pass.constants.js";
import { ValidationError } from "../../shared/errors/app-error.js";

const EXTENSION_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EVIDENCE_PHOTO_BYTES, files: 1 },
  fileFilter(req, file, callback) {
    if (!ALLOWED_PHOTO_MIME_TYPES.includes(file.mimetype)) {
      return callback(new ValidationError("Photo must be JPEG, PNG, or WebP."));
    }

    return callback(null, true);
  },
});

export const evidencePhotoUpload = upload.single("photo");

// Normalizes the multer file into the shape gate-pass.service expects,
// deriving the extension from the verified MIME type — never from the
// client-supplied original filename.
export function extractPhoto(req) {
  if (!req.file) {
    return null;
  }

  return {
    buffer: req.file.buffer,
    mimeType: req.file.mimetype,
    extension: EXTENSION_BY_MIME[req.file.mimetype],
  };
}
