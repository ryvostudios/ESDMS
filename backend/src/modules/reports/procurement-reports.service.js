import ExcelJS from "exceljs";
import pool from "../../config/database.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../shared/errors/app-error.js";
import { sanitizeCell, safeExportFilename } from "../../shared/reports/excel-safety.js";
import { recordGovernanceAudit } from "../../shared/audit/governance-audit.repository.js";
import { resolveSupplyChainScope } from "../../shared/authorization/supply-chain-scope.js";

export const EXPORT_PERMISSION = "procurement.export";
const PRICE_PERMISSIONS = ["procurement.view_prices", "procurement.purchase", "procurement.pricing"];

// Export authority NEVER widens data authority. procurement.export only says
// "this user may take what they can already see out of the application"; every
// commercial column is gated again, here, on the same price capabilities the
// live API uses.
//
// Crucially, redaction is a QUERY-PROJECTION decision, not a post-processing
// one: an unauthorized export never SELECTs a price column at all, so there is
// no window in which price data exists in this process and is merely being
// hidden. This mirrors the Workforce compensation precedent exactly
// (docs/SECURITY.md §13).
function canSeePrices(actor) {
  return PRICE_PERMISSIONS.some((code) => actor.permissions.has(code));
}

function assertCanExport(actor) {
  if (!actor.permissions.has(EXPORT_PERMISSION)) {
    throw new ForbiddenError();
  }
}

// Shared server-side scope + filter clause. Every dataset applies it, so no
// export can reach another department's or another site's rows, and no filter
// arrives from the client as raw SQL.
function buildScopeClause(actor, filters, { siteColumn, departmentColumn, dateColumn, statusColumn, numberColumns }) {
  const scope = resolveSupplyChainScope(actor);
  const conditions = [];
  const values = [];

  if (scope.tier === "OWN" && !scope.departmentId) {
    return null;
  }
  if (filters.departmentId && scope.tier === "OWN" && filters.departmentId !== scope.departmentId) {
    throw new NotFoundError("Record not found.");
  }
  if (filters.siteId && scope.tier !== "ALL" && filters.siteId !== scope.siteId) {
    throw new NotFoundError("Record not found.");
  }

  const siteId = scope.tier === "ALL" ? filters.siteId || null : scope.siteId;
  const departmentId = filters.departmentId || (scope.tier === "OWN" ? scope.departmentId : null);

  values.push(siteId);
  conditions.push(`($${values.length}::uuid IS NULL OR ${siteColumn} = $${values.length})`);
  values.push(departmentId);
  conditions.push(`($${values.length}::uuid IS NULL OR ${departmentColumn} = $${values.length})`);

  if (filters.from) {
    values.push(filters.from);
    conditions.push(`${dateColumn} >= $${values.length}::date`);
  }
  if (filters.to) {
    values.push(filters.to);
    // Inclusive of the whole "to" day.
    conditions.push(`${dateColumn} < ($${values.length}::date + interval '1 day')`);
  }
  if (filters.status && statusColumn) {
    values.push(filters.status);
    conditions.push(`${statusColumn} = $${values.length}`);
  }
  if (filters.reference && numberColumns?.length) {
    values.push(`%${filters.reference}%`);
    conditions.push(`(${numberColumns.map((column) => `${column} ILIKE $${values.length}`).join(" OR ")})`);
  }

  return { where: `WHERE ${conditions.join(" AND ")}`, values, scope };
}

// One request must not be able to exhaust server memory by asking for the
// whole history: the workbook is assembled in memory, so the result set is
// bounded and an oversized request is refused with a useful message rather
// than truncated silently. Deliberately not a report queue — this scale does
// not justify one.
const MAX_EXPORT_ROWS = 50_000;

const MONEY = "#,##0.00";
const QUANTITY = "#,##0.00";
const DATETIME = "yyyy-mm-dd hh:mm";

// Every dataset declares its operational columns and, separately, its
// commercial ones. `commercial` columns are only ever selected and written
// when the actor holds price authority.
const DATASETS = {
  "demand-history": {
    name: "Demand History",
    build: ({ where, values }, includePrices) => ({
      sheet: "Demand History",
      columns: [
        { header: "Demand #", key: "demand_number", width: 18, type: "text" },
        { header: "Revision", key: "revision", width: 10, type: "number" },
        { header: "Site", key: "site_name", width: 22, type: "text" },
        { header: "Department", key: "department_name", width: 22, type: "text" },
        { header: "Created By", key: "created_by_name", width: 24, type: "text" },
        { header: "Status", key: "status", width: 24, type: "text" },
        { header: "Item", key: "item_name_snapshot", width: 30, type: "text" },
        { header: "Requested Qty", key: "requested_quantity", width: 15, type: "quantity" },
        { header: "UOM", key: "uom_code_snapshot", width: 10, type: "text" },
        { header: "Line Decision", key: "line_disposition", width: 22, type: "text" },
        { header: "Exclusion Reason", key: "exclusion_category", width: 20, type: "text" },
        { header: "Created", key: "created_at", width: 18, type: "datetime" },
        { header: "Submitted", key: "submitted_at", width: 18, type: "datetime" },
        { header: "Initial Approved", key: "initial_approved_at", width: 18, type: "datetime" },
        { header: "Final Approved", key: "final_approved_at", width: 18, type: "datetime" },
        { header: "Completed", key: "completed_at", width: 18, type: "datetime" },
        ...(includePrices
          ? [{ header: "Estimated Unit Price", key: "estimated_unit_price", width: 18, type: "money" }]
          : []),
      ],
      sql: `
        SELECT md.demand_number, md.revision, s.name AS site_name, d.name AS department_name,
               u.full_name AS created_by_name, md.status,
               mdl.item_name_snapshot, mdl.requested_quantity, mdl.uom_code_snapshot,
               COALESCE(disp.disposition, 'APPROVED_FOR_PURCHASE') AS line_disposition,
               disp.exclusion_category,
               md.created_at, md.submitted_at,
               (SELECT max(a.created_at) FROM material_demand_approvals a
                WHERE a.demand_id = md.id AND a.approval_stage = 'INITIAL' AND a.decision = 'APPROVED')
                 AS initial_approved_at,
               (SELECT max(a.created_at) FROM material_demand_approvals a
                WHERE a.demand_id = md.id AND a.approval_stage = 'FINAL' AND a.decision = 'APPROVED')
                 AS final_approved_at,
               i.completed_at
               ${includePrices ? ", mdpl.estimated_unit_price" : ""}
        FROM material_demands md
        JOIN sites s ON s.id = md.site_id
        JOIN departments d ON d.id = md.department_id
        JOIN users u ON u.id = md.created_by_user_id
        JOIN material_demand_lines mdl ON mdl.demand_id = md.id
        LEFT JOIN ipos i ON i.demand_id = md.id AND i.demand_revision = md.revision
        -- The ONE authoritative Pricing version for this row: the exact
        -- version the IPO was generated from, or — before an IPO exists — the
        -- latest submitted one. Joining every SUBMITTED version would
        -- duplicate a repriced Demand and present a rejected v1 alongside the
        -- approved v2 as though both were authoritative.
        LEFT JOIN LATERAL (
          SELECT p.id, p.version
          FROM material_demand_pricing p
          WHERE p.demand_id = md.id AND p.demand_revision = md.revision
            AND (p.id = i.pricing_id OR (i.id IS NULL AND p.status = 'SUBMITTED'))
          ORDER BY (p.id = i.pricing_id) DESC, p.version DESC
          LIMIT 1
        ) p ON true
        LEFT JOIN material_demand_line_dispositions disp
          ON disp.demand_line_id = mdl.id AND disp.pricing_id = p.id
        ${includePrices ? "LEFT JOIN material_demand_pricing_lines mdpl ON mdpl.demand_line_id = mdl.id AND mdpl.pricing_id = p.id" : ""}
        ${where}
        ORDER BY md.created_at DESC, mdl.line_no ASC
      `,
      values,
    }),
    scope: {
      siteColumn: "md.site_id",
      departmentColumn: "md.department_id",
      dateColumn: "md.created_at",
      statusColumn: "md.status",
      numberColumns: ["md.demand_number"],
    },
  },

  "ipo-history": {
    name: "IPO History",
    build: ({ where, values }, includePrices) => ({
      sheet: "IPO History",
      columns: [
        { header: "IPO #", key: "ipo_number", width: 20, type: "text" },
        { header: "Demand #", key: "demand_number", width: 18, type: "text" },
        { header: "Revision", key: "demand_revision", width: 10, type: "number" },
        { header: "Site", key: "site_name", width: 22, type: "text" },
        { header: "Department", key: "department_name", width: 22, type: "text" },
        { header: "Status", key: "status", width: 16, type: "text" },
        { header: "Generated", key: "generated_at", width: 18, type: "datetime" },
        { header: "Acknowledged", key: "acknowledged_at", width: 18, type: "datetime" },
        { header: "Purchasing Closed", key: "purchasing_closed_at", width: 18, type: "datetime" },
        { header: "Completed", key: "completed_at", width: 18, type: "datetime" },
        { header: "Cancelled", key: "cancelled_at", width: 18, type: "datetime" },
        { header: "Cancellation Reason", key: "cancellation_category", width: 22, type: "text" },
        { header: "Lines", key: "line_count", width: 10, type: "number" },
        ...(includePrices
          ? [{ header: "Approved Estimate", key: "estimated_total", width: 20, type: "money" }]
          : []),
      ],
      sql: `
        SELECT i.ipo_number, md.demand_number, i.demand_revision, s.name AS site_name,
               d.name AS department_name, i.status, i.generated_at, i.acknowledged_at,
               i.purchasing_closed_at, i.completed_at, i.cancelled_at, i.cancellation_category,
               (SELECT count(*)::int FROM ipo_lines WHERE ipo_id = i.id) AS line_count
               ${includePrices ? ", i.estimated_total" : ""}
        FROM ipos i
        JOIN material_demands md ON md.id = i.demand_id
        JOIN sites s ON s.id = i.site_id
        JOIN departments d ON d.id = i.department_id
        ${where}
        ORDER BY i.generated_at DESC
      `,
      values,
    }),
    scope: {
      siteColumn: "i.site_id",
      departmentColumn: "i.department_id",
      dateColumn: "i.generated_at",
      statusColumn: "i.status",
      numberColumns: ["i.ipo_number", "md.demand_number"],
    },
  },

  "procurement-history": {
    name: "Purchasing History",
    // Inherently commercial: every row IS price data, so there is no
    // meaningful redacted form of it. Refused outright without price
    // authority rather than served as an empty shell.
    requiresPrices: true,
    build: ({ where, values }) => ({
      sheet: "Purchasing History",
      columns: [
        { header: "IPO #", key: "ipo_number", width: 20, type: "text" },
        { header: "Demand #", key: "demand_number", width: 18, type: "text" },
        { header: "Department", key: "department_name", width: 22, type: "text" },
        { header: "Item", key: "item_name_snapshot", width: 30, type: "text" },
        { header: "UOM", key: "uom_code_snapshot", width: 10, type: "text" },
        { header: "Approved Qty", key: "approved_quantity", width: 14, type: "quantity" },
        { header: "Estimated Unit Price", key: "estimated_unit_price", width: 18, type: "money" },
        { header: "Estimated Amount", key: "estimated_line_total", width: 18, type: "money" },
        { header: "Purchased Qty", key: "purchased_quantity", width: 14, type: "quantity" },
        { header: "Actual Unit Price", key: "actual_unit_price", width: 18, type: "money" },
        { header: "Actual Amount", key: "actual_line_total", width: 18, type: "money" },
        { header: "Outstanding Qty", key: "outstanding_quantity", width: 15, type: "quantity" },
        { header: "Purchase Status", key: "purchase_status", width: 20, type: "text" },
        { header: "Purchased At", key: "purchased_at", width: 18, type: "datetime" },
        { header: "Procurement Note", key: "procurement_note", width: 30, type: "text" },
      ],
      sql: `
        SELECT i.ipo_number, md.demand_number, d.name AS department_name,
               il.item_name_snapshot, il.uom_code_snapshot,
               il.approved_quantity, il.estimated_unit_price,
               (il.approved_quantity * il.estimated_unit_price)::numeric(26,2) AS estimated_line_total,
               il.purchased_quantity, ev.latest_actual_unit_price AS actual_unit_price,
               ev.actual_line_total,
               (il.approved_quantity - il.purchased_quantity)::numeric(12,2) AS outstanding_quantity,
               il.purchase_status, ev.last_purchased_at AS purchased_at, il.procurement_note
        FROM ipo_lines il
        JOIN ipos i ON i.id = il.ipo_id
        JOIN material_demands md ON md.id = i.demand_id
        JOIN departments d ON d.id = i.department_id
        -- Exact money from the recorded purchase events: a line bought
        -- 60 @ 100 then 20 @ 110 totals 8,200, which no single cumulative
        -- price column could reproduce.
        LEFT JOIN LATERAL (
          SELECT SUM(e.quantity * e.actual_unit_price)::numeric(26,2) AS actual_line_total,
                 MAX(e.purchased_at) AS last_purchased_at,
                 (SELECT actual_unit_price FROM ipo_purchase_events
                   WHERE ipo_line_id = il.id ORDER BY purchased_at DESC, id DESC LIMIT 1)
                   AS latest_actual_unit_price
          FROM ipo_purchase_events e WHERE e.ipo_line_id = il.id
        ) ev ON true
        ${where}
        ORDER BY i.generated_at DESC, il.line_no ASC
      `,
      values,
    }),
    scope: {
      siteColumn: "i.site_id",
      departmentColumn: "i.department_id",
      dateColumn: "i.generated_at",
      statusColumn: "il.purchase_status",
      numberColumns: ["i.ipo_number", "md.demand_number"],
    },
  },

  "delivery-challan-history": {
    name: "Delivery Challan History",
    build: ({ where, values }) => ({
      sheet: "Delivery Challans",
      columns: [
        { header: "DC #", key: "dc_number", width: 20, type: "text" },
        { header: "IPO #", key: "ipo_number", width: 20, type: "text" },
        { header: "Demand #", key: "demand_number", width: 18, type: "text" },
        { header: "Department", key: "department_name", width: 22, type: "text" },
        { header: "Site", key: "site_name", width: 22, type: "text" },
        { header: "Status", key: "status", width: 16, type: "text" },
        { header: "Item", key: "item_name_snapshot", width: 30, type: "text" },
        { header: "Quantity", key: "quantity", width: 14, type: "quantity" },
        { header: "UOM", key: "uom_code_snapshot", width: 10, type: "text" },
        { header: "Created", key: "created_at", width: 18, type: "datetime" },
        { header: "Finalized", key: "finalized_at", width: 18, type: "datetime" },
        { header: "Completed", key: "completed_at", width: 18, type: "datetime" },
      ],
      sql: `
        SELECT dc.dc_number, i.ipo_number, md.demand_number, d.name AS department_name,
               s.name AS site_name, dc.status, dcl.item_name_snapshot, dcl.quantity,
               dcl.uom_code_snapshot, dc.created_at, dc.finalized_at, dc.completed_at
        FROM delivery_challans dc
        JOIN ipos i ON i.id = dc.ipo_id
        JOIN material_demands md ON md.id = i.demand_id
        JOIN departments d ON d.id = dc.department_id
        JOIN sites s ON s.id = dc.site_id
        JOIN delivery_challan_lines dcl ON dcl.dc_id = dc.id
        ${where}
        ORDER BY dc.created_at DESC, dcl.line_no ASC
      `,
      values,
    }),
    scope: {
      siteColumn: "dc.site_id",
      departmentColumn: "dc.department_id",
      dateColumn: "dc.created_at",
      statusColumn: "dc.status",
      numberColumns: ["dc.dc_number", "i.ipo_number"],
    },
  },

  "receiving-history": {
    name: "Receiving History",
    build: ({ where, values }) => ({
      sheet: "Receiving History",
      columns: [
        { header: "Demand #", key: "demand_number", width: 18, type: "text" },
        { header: "IPO #", key: "ipo_number", width: 20, type: "text" },
        { header: "DC #", key: "dc_number", width: 20, type: "text" },
        { header: "Department", key: "department_name", width: 22, type: "text" },
        { header: "Site", key: "site_name", width: 22, type: "text" },
        { header: "Receipt Type", key: "receipt_type", width: 18, type: "text" },
        { header: "Received By", key: "received_by_name", width: 24, type: "text" },
        { header: "Physical Receiver", key: "physical_receiver_name", width: 24, type: "text" },
        { header: "Received At", key: "received_at", width: 18, type: "datetime" },
        { header: "Handover To", key: "handover_to_name", width: 24, type: "text" },
        { header: "Handover At", key: "handover_at", width: 18, type: "datetime" },
        { header: "Confirmed By", key: "confirmed_by_name", width: 24, type: "text" },
        { header: "Confirmed At", key: "confirmed_at", width: 18, type: "datetime" },
        { header: "Status", key: "status", width: 24, type: "text" },
        { header: "Item", key: "item_name_snapshot", width: 30, type: "text" },
        { header: "DC Qty", key: "dc_quantity", width: 12, type: "quantity" },
        { header: "Received Qty", key: "received_quantity", width: 14, type: "quantity" },
        { header: "Discrepancy Qty", key: "discrepancy_quantity", width: 15, type: "quantity" },
        { header: "Discrepancy Type", key: "discrepancy_type", width: 18, type: "text" },
        { header: "Discrepancy Note", key: "discrepancy_note", width: 30, type: "text" },
      ],
      sql: `
        SELECT md.demand_number, i.ipo_number, dc.dc_number, d.name AS department_name,
               s.name AS site_name, mr.receipt_type, ru.full_name AS received_by_name,
               e.full_legal_name AS physical_receiver_name, mr.received_at,
               hu.full_name AS handover_to_name, mr.handover_at,
               cu.full_name AS confirmed_by_name, mr.confirmed_at, mr.status,
               mrl.item_name_snapshot, mrl.dc_quantity, mrl.received_quantity,
               mrl.discrepancy_quantity, mrl.discrepancy_type, mrl.discrepancy_note
        FROM material_receipts mr
        JOIN delivery_challans dc ON dc.id = mr.dc_id
        JOIN ipos i ON i.id = mr.ipo_id
        JOIN material_demands md ON md.id = i.demand_id
        JOIN departments d ON d.id = mr.department_id
        JOIN sites s ON s.id = mr.site_id
        JOIN users ru ON ru.id = mr.received_by_user_id
        LEFT JOIN employees e ON e.id = mr.physical_receiver_employee_id
        LEFT JOIN users hu ON hu.id = mr.handover_to_user_id
        LEFT JOIN users cu ON cu.id = mr.confirmed_by_user_id
        JOIN material_receipt_lines mrl ON mrl.receipt_id = mr.id
        ${where}
        ORDER BY mr.received_at DESC, mrl.line_no ASC
      `,
      values,
    }),
    scope: {
      siteColumn: "mr.site_id",
      departmentColumn: "mr.department_id",
      dateColumn: "mr.received_at",
      statusColumn: "mr.status",
      numberColumns: ["dc.dc_number", "i.ipo_number", "md.demand_number"],
    },
  },

  traceability: {
    name: "Complete Traceability",
    build: ({ where, values }, includePrices) => ({
      sheet: "Traceability",
      columns: [
        { header: "Demand #", key: "demand_number", width: 18, type: "text" },
        { header: "Demand Status", key: "demand_status", width: 22, type: "text" },
        { header: "Department", key: "department_name", width: 22, type: "text" },
        { header: "Site", key: "site_name", width: 22, type: "text" },
        { header: "Item", key: "item_name_snapshot", width: 30, type: "text" },
        { header: "UOM", key: "uom_code_snapshot", width: 10, type: "text" },
        { header: "Requested Qty", key: "requested_quantity", width: 14, type: "quantity" },
        { header: "Line Decision", key: "line_disposition", width: 22, type: "text" },
        { header: "IPO #", key: "ipo_number", width: 20, type: "text" },
        { header: "Approved Qty", key: "approved_quantity", width: 14, type: "quantity" },
        { header: "Purchased Qty", key: "purchased_quantity", width: 14, type: "quantity" },
        { header: "Outstanding Qty", key: "outstanding_quantity", width: 15, type: "quantity" },
        { header: "Delivered Qty", key: "delivered_quantity", width: 14, type: "quantity" },
        { header: "Received Qty", key: "received_quantity", width: 14, type: "quantity" },
        { header: "Discrepancy Qty", key: "discrepancy_quantity", width: 15, type: "quantity" },
        { header: "Completed", key: "completed_at", width: 18, type: "datetime" },
        ...(includePrices
          ? [
              { header: "Estimated Unit Price", key: "estimated_unit_price", width: 18, type: "money" },
              { header: "Actual Unit Price", key: "actual_unit_price", width: 18, type: "money" },
            ]
          : []),
      ],
      sql: `
        SELECT md.demand_number, md.status AS demand_status, d.name AS department_name,
               s.name AS site_name, mdl.item_name_snapshot, mdl.uom_code_snapshot,
               mdl.requested_quantity,
               COALESCE(disp.disposition, 'APPROVED_FOR_PURCHASE') AS line_disposition,
               i.ipo_number, il.approved_quantity, il.purchased_quantity,
               (il.approved_quantity - il.purchased_quantity)::numeric(12,2) AS outstanding_quantity,
               COALESCE(alloc.delivered, 0)::numeric(12,2) AS delivered_quantity,
               COALESCE(recv.received, 0)::numeric(12,2) AS received_quantity,
               COALESCE(recv.discrepancy, 0)::numeric(12,2) AS discrepancy_quantity,
               i.completed_at
               ${includePrices ? ", il.estimated_unit_price, ev.latest_actual_unit_price AS actual_unit_price" : ""}
        FROM material_demands md
        JOIN sites s ON s.id = md.site_id
        JOIN departments d ON d.id = md.department_id
        JOIN material_demand_lines mdl ON mdl.demand_id = md.id
        LEFT JOIN ipos i ON i.demand_id = md.id AND i.demand_revision = md.revision
        LEFT JOIN ipo_lines il ON il.ipo_id = i.id AND il.demand_line_id = mdl.id
        -- The ONE authoritative Pricing version for this row: the exact
        -- version the IPO was generated from, or — before an IPO exists — the
        -- latest submitted one. Joining every SUBMITTED version would
        -- duplicate a repriced Demand and present a rejected v1 alongside the
        -- approved v2 as though both were authoritative.
        LEFT JOIN LATERAL (
          SELECT p.id, p.version
          FROM material_demand_pricing p
          WHERE p.demand_id = md.id AND p.demand_revision = md.revision
            AND (p.id = i.pricing_id OR (i.id IS NULL AND p.status = 'SUBMITTED'))
          ORDER BY (p.id = i.pricing_id) DESC, p.version DESC
          LIMIT 1
        ) p ON true
        LEFT JOIN material_demand_line_dispositions disp
          ON disp.demand_line_id = mdl.id AND disp.pricing_id = p.id
        LEFT JOIN LATERAL (
          SELECT SUM(dcl.quantity) AS delivered
          FROM delivery_challan_lines dcl JOIN delivery_challans dc ON dc.id = dcl.dc_id
          WHERE dcl.ipo_line_id = il.id AND dc.status <> 'CANCELLED'
        ) alloc ON true
        LEFT JOIN LATERAL (
          SELECT SUM(mrl.received_quantity) AS received, SUM(mrl.discrepancy_quantity) AS discrepancy
          FROM material_receipt_lines mrl
          JOIN delivery_challan_lines dcl2 ON dcl2.id = mrl.dc_line_id
          WHERE dcl2.ipo_line_id = il.id
        ) recv ON true
        LEFT JOIN LATERAL (
          SELECT (SELECT actual_unit_price FROM ipo_purchase_events
                   WHERE ipo_line_id = il.id ORDER BY purchased_at DESC, id DESC LIMIT 1)
                   AS latest_actual_unit_price
        ) ev ON true
        ${where}
        ORDER BY md.created_at DESC, mdl.line_no ASC
      `,
      values,
    }),
    scope: {
      siteColumn: "md.site_id",
      departmentColumn: "md.department_id",
      dateColumn: "md.created_at",
      statusColumn: "md.status",
      numberColumns: ["md.demand_number", "i.ipo_number"],
    },
  },
};

export function procurementExportCatalog(actor) {
  if (!actor.permissions.has(EXPORT_PERMISSION)) return [];
  const includePrices = canSeePrices(actor);

  return Object.entries(DATASETS)
    .filter(([, dataset]) => !dataset.requiresPrices || includePrices)
    .map(([key, dataset]) => ({ key, name: dataset.name, includesPricing: includePrices }));
}

function writeCell(row, column, value) {
  if (value === null || value === undefined) return "";

  switch (column.type) {
    case "money":
    case "quantity":
      // Kept as a real number so the spreadsheet can total it, with an
      // explicit format rather than a pre-formatted string.
      return Number(value);
    case "number":
      return Number(value);
    case "datetime":
      return new Date(value);
    default:
      // OWASP formula-injection mitigation for every user-controllable
      // string (item names, notes, people's names) — see excel-safety.js.
      return sanitizeCell(String(value));
  }
}

export async function generateProcurementExport(actor, datasetKey, filters) {
  assertCanExport(actor);

  const dataset = DATASETS[datasetKey];
  if (!dataset) throw new NotFoundError("Report not found.");

  const includePrices = canSeePrices(actor);
  if (dataset.requiresPrices && !includePrices) {
    throw new ForbiddenError("This export contains commercial information you are not authorized to view.");
  }

  const scoped = buildScopeClause(actor, filters, dataset.scope);
  const built = scoped
    ? dataset.build(scoped, includePrices)
    : dataset.build({ where: "WHERE false", values: [] }, includePrices);

  // One row over the limit is fetched deliberately: its presence is what
  // distinguishes "exactly at the limit" from "too large".
  const result = await pool.query(`${built.sql} LIMIT ${MAX_EXPORT_ROWS + 1}`, built.values);

  if (result.rowCount > MAX_EXPORT_ROWS) {
    throw new ValidationError(
      `This export matches more than ${MAX_EXPORT_ROWS.toLocaleString("en-US")} rows. Narrow the date range, department or site and try again.`,
    );
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(built.sheet);
  sheet.columns = built.columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width,
  }));
  sheet.getRow(1).font = { bold: true };

  for (const row of result.rows) {
    const written = {};
    for (const column of built.columns) {
      written[column.key] = writeCell(row, column, row[column.key]);
    }
    sheet.addRow(written);
  }

  built.columns.forEach((column, index) => {
    const excelColumn = sheet.getColumn(index + 1);
    if (column.type === "money") excelColumn.numFmt = MONEY;
    if (column.type === "quantity") excelColumn.numFmt = QUANTITY;
    if (column.type === "datetime") excelColumn.numFmt = DATETIME;
  });

  const buffer = await workbook.xlsx.writeBuffer();

  await recordGovernanceAudit(pool, {
    actorUserId: actor.id,
    action: "PROCUREMENT_EXPORT_GENERATED",
    metadata: {
      dataset: datasetKey,
      recordCount: result.rowCount,
      includedPricing: includePrices,
      // The filters actually applied, so an export is reproducible and its
      // scope is provable after the fact.
      filters: {
        siteId: filters.siteId || null,
        departmentId: filters.departmentId || null,
        from: filters.from || null,
        to: filters.to || null,
        status: filters.status || null,
        reference: filters.reference || null,
      },
    },
  });

  return { buffer, filename: safeExportFilename(datasetKey, "xlsx") };
}
