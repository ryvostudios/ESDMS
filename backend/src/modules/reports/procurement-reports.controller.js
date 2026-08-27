import { z } from "zod";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError } from "../../shared/errors/app-error.js";
import { generateProcurementExport, procurementExportCatalog } from "./procurement-reports.service.js";

// Filters are applied server-side, in SQL, against a scoped query — the
// browser never receives an unfiltered dataset to narrow down itself.
const exportQuerySchema = z
  .object({
    siteId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    status: z.string().trim().max(40).optional(),
    reference: z.string().trim().max(100).optional(),
  })
  .strict();

export const catalog = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: procurementExportCatalog(req.user) });
});

export const download = asyncHandler(async (req, res) => {
  const parsed = exportQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ValidationError("Invalid export request.", parsed.error.flatten());

  const { buffer, filename } = await generateProcurementExport(req.user, req.params.datasetKey, parsed.data);

  res.set({
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "private, no-store",
  });
  res.status(200).send(Buffer.from(buffer));
});
