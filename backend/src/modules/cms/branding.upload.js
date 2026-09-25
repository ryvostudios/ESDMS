import zlib from "node:zlib";
import multer from "multer";
import { flatMultipartLimits } from "../../shared/http/multipart-limits.js";
import PDFDocument from "pdfkit";
import { ValidationError } from "../../shared/errors/app-error.js";
import { guardParsedBody } from "../../shared/http/text-safety.js";

// Company logo upload. Parallel to the other per-module upload files (see
// profile/photo.upload.js): memory storage, a hard size ceiling, and the
// declared type re-checked against the actual bytes. Raster PNG/JPEG only —
// never SVG, so an uploaded "logo" can never become script or markup.
//
// Beyond the signature, the image is parsed the same way the PDF renderer
// will parse it, and a PNG's compressed pixel data is fully inflated here,
// synchronously. A file that would fail later inside document generation is
// therefore rejected at upload instead.
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const MIN_DIMENSION = 32;
const MAX_DIMENSION = 4096;
const EXTENSION_BY_MIME = { "image/png": "png", "image/jpeg": "jpg" };
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: flatMultipartLimits({ fileSize: MAX_LOGO_BYTES, fields: 1, fieldSize: 11, fieldNameSize: 8 }),
  fileFilter(req, file, callback) {
    if (!EXTENSION_BY_MIME[file.mimetype]) {
      return callback(new ValidationError("Logo must be a PNG or JPEG image."));
    }
    return callback(null, true);
  },
});

export const logoUpload = guardParsedBody(upload.single("logo"));

function isJpeg(buffer) {
  return buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
}

// Walks the chunk list and inflates IDAT; throws on any structural problem.
function assertDecodablePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("signature");
  let offset = 8;
  let header = null;
  const data = [];
  let ended = false;
  while (offset + 8 <= buffer.length && !ended) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length || offset + 12 + length > buffer.length) throw new Error("truncated");
    if (!header && type !== "IHDR") throw new Error("IHDR first");
    if (type === "IHDR") {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), bitDepth: body[8], colorType: body[9], interlace: body[12] };
    } else if (type === "IDAT") {
      data.push(body);
    } else if (type === "IEND") {
      ended = true;
    }
    offset += 12 + length;
  }
  const channels = PNG_CHANNELS[header?.colorType];
  if (!ended || !channels || !data.length) throw new Error("structure");
  const pixels = zlib.inflateSync(Buffer.concat(data), { maxOutputLength: 128 * 1024 * 1024 });
  if (header.interlace === 0) {
    const rowBytes = Math.ceil((header.width * channels * header.bitDepth) / 8);
    if (pixels.length !== header.height * (rowBytes + 1)) throw new Error("pixel length");
  }
}

export function extractLogo(req) {
  if (!req.file) throw new ValidationError("No logo file was provided.");
  const { buffer, mimetype } = req.file;

  try {
    if (mimetype === "image/png") assertDecodablePng(buffer);
    else if (!isJpeg(buffer)) throw new Error("signature");
    const image = new PDFDocument({ autoFirstPage: false }).openImage(buffer);
    if (![image.width, image.height].every((size) => size >= MIN_DIMENSION && size <= MAX_DIMENSION)) {
      throw new ValidationError(`Logo must be between ${MIN_DIMENSION} and ${MAX_DIMENSION} pixels on each side.`);
    }
    return { buffer, mimeType: mimetype, extension: EXTENSION_BY_MIME[mimetype], width: image.width, height: image.height };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("The uploaded file is not a valid PNG or JPEG image.");
  }
}
