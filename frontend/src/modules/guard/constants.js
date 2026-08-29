// Mirrors backend/src/modules/gate-pass/gate-pass.constants.js — UX-only
// validation; the backend remains authoritative.
export const MAX_EVIDENCE_PHOTO_BYTES = 5 * 1024 * 1024;
// Mirrors MAX_EVIDENCE_PHOTOS_PER_REQUEST on the server. The server is still
// the authority; this only stops the Guard from queueing an upload it already
// knows will be refused.
export const MAX_EVIDENCE_PHOTOS = 10;
export const ALLOWED_PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
