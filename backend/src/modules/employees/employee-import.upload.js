import multer from "multer";
import { flatMultipartLimits } from "../../shared/http/multipart-limits.js";
import { ValidationError } from "../../shared/errors/app-error.js";
import { guardParsedBody } from "../../shared/http/text-safety.js";

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: flatMultipartLimits({ fileSize: MAX_IMPORT_BYTES, fields: 2, fieldSize: 512, fieldNameSize: 17 }),
  fileFilter(_req, file, callback) {
    if (file.mimetype !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      return callback(new ValidationError("Only .xlsx workbooks are accepted."));
    }
    return callback(null, true);
  },
});

export const employeeImportUpload = guardParsedBody(upload.single("file"));

export function extractEmployeeImport(req) {
  if (!req.file) throw new ValidationError("No import workbook was provided.");
  if (req.file.buffer.length < 4 || req.file.buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new ValidationError("The uploaded file is not a valid .xlsx workbook.");
  }
  return req.file.buffer;
}
