#!/usr/bin/env node
// NON-PRODUCTION reset of operational/demo data, so an owner can rebuild
// their organization by hand through the UI without reinstalling anything.
//
// What this is NOT: it is not a migration-down, not a TRUNCATE, and not a way
// to weaken any of the append-only guarantees the application relies on. The
// runtime database role still cannot delete a Gate Pass or rewrite an audit
// log after this script has run — the delete-blocking triggers are disabled
// only for the duration of one transaction, by the table OWNER, and are
// re-enabled inside that same transaction, so an abort restores them too.
//
// Safety, in order:
//   1. Refuses outright when NODE_ENV is production.
//   2. Refuses a database whose name looks like production.
//   3. Requires ESDMS_RESET_CONFIRM to exactly equal the target database
//      name, so a copy-pasted command cannot hit the wrong database.
//   4. Runs in ONE transaction: either the whole reset lands or none of it.
//   5. Verifies afterwards that every table it claims to clear is actually
//      empty, and that the preserved reference data and bootstrap login
//      survived — then reports what it removed.
//
// Repeatable: running it twice is a no-op the second time.
import "dotenv/config";
import pg from "pg";

// Its own client rather than src/config/database.js: this is a maintenance
// script, and it must be able to refuse a production target with a clear
// message instead of failing first on unrelated application configuration
// (FRONTEND_ORIGIN and friends) that a reset has no use for.
const { Client } = pg;

// Deleted in this order, children before parents. This is deliberately an
// explicit, reviewable list rather than a generic "delete from everything"
// loop: the order IS the dependency documentation, and a table added later
// without being placed here fails the emptiness check at the end loudly
// instead of being silently skipped.
const OPERATIONAL_TABLES_IN_DELETE_ORDER = [
  // Receiving depends on Delivery Challans, which depend on IPOs.
  "material_receipt_lines",
  "material_receipts",
  "delivery_challan_lines",
  "delivery_challans",
  "procurement_documents",
  "ipo_purchase_events",
  "ipo_lines",
  "ipos",

  // Demand and pricing.
  "carry_forward_allocations",
  "material_demand_line_dispositions",
  "material_demand_pricing_lines",
  "material_demand_pricing",
  "material_demand_approvals",
  "material_demand_audit_log",
  "material_demand_lines",
  "material_demands",

  // Gate Pass, including every evidence file row.
  "gate_pass_audit_log",
  "gate_pass_items",
  // gate_passes references its own photo rows, so the parent's references are
  // cleared before the files they point at.
  "gate_passes",
  "gate_pass_files",

  // Fleet master data.
  "vehicles",
  "drivers",

  // Materials.
  "department_material_catalog",
  "company_items",

  // Workforce records, then the employees they hang off.
  "employee_rotation_ledger",
  "leave_requests",
  "employee_compensation_records",
  "employee_contracts",
  "employee_document_requests",
  "employee_documents",
  "employee_profile_photos",
  "employee_custom_field_values",
  "employee_emergency_contacts",
  "employee_personal_details",
  "employee_business_history",
  "temporary_assignments",
  "employment_assignments",
  "employees",

  // Organization and workforce configuration the owner recreates in the UI.
  "employee_custom_fields",
  "employee_profile_sections",
  "employee_document_types",
  "leave_types",
  "rotation_policies",
  "employment_types",
  "positions",
  "departments",

  // Governance and delivery. Audit rows are cleared because they describe
  // exactly the demo activity being removed; keeping them would leave an
  // audit trail pointing at users and records that no longer exist.
  "governance_audit_log",
  "procurement_audit_log",
  "notification_outbox",
  "user_permission_bundle_assignments",
  "user_permission_overrides",

  // Document/number counters, so a rebuilt organization starts numbering at 1.
  "gate_pass_number_counters",
  "material_demand_number_counters",
  "employee_contract_number_counters",
  "document_number_counters",
];

// Never touched: schema/migrations, the role and permission model, capability
// bundles, units of measure, document-number settings, one Site, and the
// bootstrap login.
const PRESERVED_TABLES = [
  "pgmigrations",
  "roles",
  "permissions",
  "role_permissions",
  "permission_bundles",
  "permission_bundle_permissions",
  "units_of_measure",
  "document_number_settings",
  "sites",
  "users",
];

// Tables whose triggers refuse DELETE (or UPDATE) by design. Disabled only
// inside the reset transaction, and re-enabled before it commits.
const TABLES_WITH_PROTECTIVE_TRIGGERS = [
  "carry_forward_allocations",
  "delivery_challans",
  "delivery_challan_lines",
  "employee_business_history",
  "employee_compensation_records",
  "employee_contracts",
  "employee_documents",
  "employee_profile_photos",
  "employee_rotation_ledger",
  "gate_pass_audit_log",
  "gate_pass_files",
  "gate_passes",
  "governance_audit_log",
  "ipo_lines",
  "ipo_purchase_events",
  "ipos",
  "material_demand_approvals",
  "material_demand_audit_log",
  "material_demand_pricing",
  "material_demand_pricing_lines",
  "material_demands",
  "material_receipt_lines",
  "material_receipts",
  "procurement_audit_log",
  "procurement_documents",
];

function assertSafeTarget() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to reset: NODE_ENV is production.");
  }

  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required.");

  const url = new URL(raw);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));

  if (/prod/i.test(databaseName) || /prod/i.test(url.hostname)) {
    throw new Error(`Refusing to reset: "${databaseName}" on ${url.hostname} looks like a production target.`);
  }

  // Naming the database explicitly is the last line of defence: an operator
  // who pasted the wrong DATABASE_URL has to also name that wrong database
  // before anything is deleted.
  if (process.env.ESDMS_RESET_CONFIRM !== databaseName) {
    throw new Error(
      `Refusing to reset: set ESDMS_RESET_CONFIRM="${databaseName}" to confirm the target database.`,
    );
  }

  return { databaseName, host: url.hostname };
}

async function countRows(client, tables) {
  const counts = {};
  for (const table of tables) {
    const result = await client.query(`SELECT count(*)::int AS total FROM public.${table}`);
    counts[table] = result.rows[0].total;
  }
  return counts;
}

async function resolveBootstrapUser(client) {
  // The oldest active CEO is the bootstrap login. Chosen by created_at rather
  // than by email so the script needs no configuration to find it, and so
  // re-running keeps the same account.
  const result = await client.query(
    `SELECT u.id, u.email, u.full_name, u.site_id
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.name = 'CEO' AND u.is_active = true
     ORDER BY u.created_at, u.id
     LIMIT 1`,
  );
  return result.rows[0] || null;
}

async function main() {
  const target = assertSafeTarget();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query("BEGIN");

    const bootstrap = await resolveBootstrapUser(client);
    if (!bootstrap) {
      throw new Error(
        "Refusing to reset: no active CEO account exists to preserve. "
          + "Run scripts/create-ceo-user.js first, so there is still a way in afterwards.",
      );
    }

    const before = await countRows(client, OPERATIONAL_TABLES_IN_DELETE_ORDER);

    for (const table of TABLES_WITH_PROTECTIVE_TRIGGERS) {
      await client.query(`ALTER TABLE public.${table} DISABLE TRIGGER USER`);
    }

    // Every non-bootstrap user goes; the bootstrap CEO stays, detached from
    // the department it is about to lose. (The employee side of the link
    // lives on employees.user_id, which is deleted with the employees.)
    await client.query("UPDATE users SET department_id = NULL");

    for (const table of OPERATIONAL_TABLES_IN_DELETE_ORDER) {
      await client.query(`DELETE FROM public.${table}`);
    }

    await client.query("DELETE FROM users WHERE id <> $1", [bootstrap.id]);

    // Exactly one Site survives: the bootstrap CEO's own.
    await client.query("DELETE FROM sites WHERE id <> $1", [bootstrap.site_id]);

    for (const table of TABLES_WITH_PROTECTIVE_TRIGGERS) {
      await client.query(`ALTER TABLE public.${table} ENABLE TRIGGER USER`);
    }

    // Verification, still inside the transaction, so a failure rolls the
    // whole thing back rather than leaving a half-reset database.
    const after = await countRows(client, OPERATIONAL_TABLES_IN_DELETE_ORDER);
    const notEmpty = Object.entries(after).filter(([, total]) => total > 0);
    if (notEmpty.length) {
      throw new Error(`Reset incomplete — still populated: ${notEmpty.map(([t, n]) => `${t}(${n})`).join(", ")}`);
    }

    const preserved = await countRows(client, PRESERVED_TABLES);
    for (const table of ["roles", "permissions", "role_permissions", "units_of_measure"]) {
      if (preserved[table] === 0) throw new Error(`Reset would have destroyed reference data: ${table} is empty.`);
    }
    if (preserved.users !== 1) throw new Error(`Expected exactly one preserved user, found ${preserved.users}.`);
    if (preserved.sites !== 1) throw new Error(`Expected exactly one preserved site, found ${preserved.sites}.`);

    const survivor = await resolveBootstrapUser(client);
    if (!survivor || survivor.id !== bootstrap.id) {
      throw new Error("Reset would have removed the bootstrap login.");
    }

    await client.query("COMMIT");

    const removed = Object.entries(before).filter(([, total]) => total > 0);
    console.log(`Reset ${target.databaseName} on ${target.host}.`);
    console.log(
      removed.length
        ? `Removed:\n${removed.map(([table, total]) => `  ${table}: ${total}`).join("\n")}`
        : "Removed: nothing (already reset).",
    );
    console.log(
      `\nPreserved: schema/migrations, ${preserved.roles} roles, ${preserved.permissions} permissions, `
        + `${preserved.permission_bundles} capability bundles, ${preserved.units_of_measure} units of measure, `
        + "1 site, and the bootstrap login "
        + `${survivor.email}.`,
    );
    console.log("\nSign in as that account and rebuild the organization through the UI.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
