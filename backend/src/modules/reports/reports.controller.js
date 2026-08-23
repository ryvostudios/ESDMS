import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError } from "../../shared/errors/app-error.js";
import { generateEmployeeMasterReport, generateWorkforceReport, reportCatalog, streamBulkFileExport } from "./reports.service.js";
import { reportQuerySchema, bulkExportSchema } from "./reports.validation.js";

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError("Invalid report request.", result.error.flatten());
  return result.data;
}

export const employeeMaster = asyncHandler(async (req, res) => {
  const { buffer, filename } = await generateEmployeeMasterReport(req.user);
  res.set({
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "private, no-store",
  });
  res.status(200).send(Buffer.from(buffer));
});

export const catalog = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: reportCatalog(req.user) });
});

export const workforceReport = asyncHandler(async (req, res) => {
  const { buffer, filename } = await generateWorkforceReport(req.user, req.params.reportKey, parse(reportQuerySchema, req.query));
  res.set({
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "private, no-store",
  });
  res.status(200).send(Buffer.from(buffer));
});

export const bulkFiles = asyncHandler(async (req, res) => {
  await streamBulkFileExport(req.user, parse(bulkExportSchema, req.body), res);
});
