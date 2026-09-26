import multer from "multer";
import { flatMultipartLimits } from "../../shared/http/multipart-limits.js";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { ValidationError } from "../../shared/errors/app-error.js";
import { guardParsedBody } from "../../shared/http/text-safety.js";

// Company logo upload. Parallel to the other per-module upload files (see
// profile/photo.upload.js): memory storage, a hard size ceiling, and the
// declared type re-checked against the actual bytes. Raster PNG/JPEG only —
// never SVG, so an uploaded "logo" can never become script or markup.
//
// The image is fully decoded (sharp, failing on any decoder warning, so a
// truncated or corrupt file is refused), its real format must match the
// declared type, and it is re-encoded canonically in that format: only
// pixels (and a PNG's transparency) survive, never trailing bytes or
// metadata. The canonical bytes are then parsed the way the PDF renderer
// will parse them, so a logo that would fail inside document generation is
// rejected at upload instead.
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const MIN_DIMENSION = 32;
const MAX_DIMENSION = 4096;
const EXTENSION_BY_MIME = { "image/png": "png", "image/jpeg": "jpg" };
const FORMAT_BY_MIME = { "image/png": "png", "image/jpeg": "jpeg" };

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

export async function extractLogo(req) {
  if (!req.file) throw new ValidationError("No logo file was provided.");
  const { buffer, mimetype } = req.file;
  const decode = () => sharp(buffer, { limitInputPixels: MAX_DIMENSION * MAX_DIMENSION, failOn: "warning" });

  try {
    const { format, width, height } = await decode().metadata();
    if (format !== FORMAT_BY_MIME[mimetype]) throw new Error("declared type does not match the image");
    if (![width, height].every((size) => size >= MIN_DIMENSION && size <= MAX_DIMENSION)) {
      throw new ValidationError(`Logo must be between ${MIN_DIMENSION} and ${MAX_DIMENSION} pixels on each side.`);
    }
    const oriented = decode().rotate();
    const { data, info } = await (format === "png" ? oriented.png() : oriented.jpeg({ quality: 90 }))
      .toBuffer({ resolveWithObject: true });
    if (data.length > MAX_LOGO_BYTES) throw new ValidationError("Logo is too large once normalized; please upload a smaller image.");
    new PDFDocument({ autoFirstPage: false }).openImage(data);
    return { buffer: data, mimeType: mimetype, extension: EXTENSION_BY_MIME[mimetype], width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("The uploaded file is not a valid PNG or JPEG image.");
  }
}

// The CMS stores one canonical 512-pixel PNG. Each public favicon/PWA size
// is derived from these validated bytes, never from a client-provided URL.
export async function extractAppIcon(req) {
  const image = await extractLogo(req);
  if (image.width !== image.height || image.width < 512) {
    throw new ValidationError("Application icon must be square and at least 512 pixels on each side.");
  }
  try {
    const buffer = await sharp(image.buffer, { limitInputPixels: 4096 * 4096, failOn: "warning" })
      .rotate().resize(512, 512).png().toBuffer();
    if (buffer.length > MAX_LOGO_BYTES) throw new Error("output too large");
    return { buffer, mimeType: "image/png", extension: "png", width: 512, height: 512 };
  } catch {
    throw new ValidationError("The uploaded application icon could not be decoded safely.");
  }
}
