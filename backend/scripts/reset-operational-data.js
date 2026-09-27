#!/usr/bin/env node
// Offline, local-only operational reset. --dry-run uses a read-only transaction.
// Execution requires exact database and backup confirmation, an existing active
// original CEO, and completed storage cleanup/disconnection. Organization,
// workforce configuration, CMS and the security model are retained.
// Delete-blocking triggers are disabled and restored only inside the database
// transaction. Failure rolls back both data changes and trigger changes.
import "dotenv/config";
import pg from "pg";
import fs from "node:fs/promises";
import path from "node:path";

// Its own client rather than src/config/database.js: this is a maintenance
// script, and it must be able to refuse a production target with a clear
// message instead of failing first on unrelated application configuration
// (FRONTEND_ORIGIN and friends) that a reset has no use for.
const { Client } = pg;

// Deleted in this order, children before parents. This is deliberately an
// explicit, reviewable list rather than a generic "delete from everything"
// loop: the order documents dependencies. Unclassified tables fail closed.
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
// bundles, units of measure, document-number settings, organization, and the
// permanent original CEO login.
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
  "departments", "positions", "employment_types", "rotation_policies",
  "leave_types", "employee_document_types", "employee_profile_sections",
  "employee_custom_fields", "cms_settings",
  "cloud_storage_active", "cloud_storage_connections",
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

const dryRun = process.argv.includes("--dry-run");

function assertSafeTarget() {
  if (process.argv.slice(2).some(arg => arg !== "--dry-run")) throw new Error("Unknown reset argument.");
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to reset: NODE_ENV is production.");
  }

  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required.");

  let url;
  try { url = new URL(raw); } catch { throw new Error("DATABASE_URL must be a valid PostgreSQL URL."); }
  if (!["postgres:","postgresql:"].includes(url.protocol)) throw new Error("DATABASE_URL must use PostgreSQL.");
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));

  if (/prod/i.test(databaseName) || /prod/i.test(url.hostname)) {
    throw new Error(`Refusing to reset: "${databaseName}" on ${url.hostname} looks like a production target.`);
  }

  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Refusing reset: only a verified local environment is supported.");
  }

  // Naming the database explicitly is the last line of defence: an operator
  // who pasted the wrong DATABASE_URL has to also name that wrong database
  // before anything is deleted.
  if (!dryRun && process.env.ESDMS_RESET_CONFIRM !== databaseName) {
    throw new Error(
      `Refusing to reset: set ESDMS_RESET_CONFIRM="${databaseName}" to confirm the target database.`,
    );
  }

  return { databaseName, host: url.hostname, port: url.port || "5432", environment: process.env.NODE_ENV || "unspecified" };
}

async function countRows(client, tables) {
  const counts = {};
  for (const table of tables) {
    const result = await client.query(`SELECT count(*)::int AS total FROM public.${table}`);
    counts[table] = result.rows[0].total;
  }
  return counts;
}

async function resolveOriginalCeo(client, email) {
  const result = await client.query(
    `SELECT u.id, u.email, u.full_name, u.site_id
     FROM users u JOIN roles r ON r.id = u.role_id JOIN sites s ON s.id=u.site_id
     WHERE r.is_active=true AND s.is_active=true AND r.name = 'CEO' AND u.is_active = true AND lower(u.email) = lower($1)`,
    [email],
  );
  return result.rows[0] || null;
}

async function main() {
  const target = assertSafeTarget();
  const originalCeoEmail = process.env.ESDMS_ORIGINAL_CEO_EMAIL?.trim();
  if (!originalCeoEmail) {
    throw new Error("Refusing to reset: ESDMS_ORIGINAL_CEO_EMAIL is required.");
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query(dryRun ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
    const actual = (await client.query("SELECT current_database() AS name")).rows[0];
    if (actual.name !== target.databaseName) throw new Error("Connected database does not match the requested target.");

    const originalCeo = await resolveOriginalCeo(client, originalCeoEmail);
    if (!originalCeo) {
      throw new Error(
        "Refusing to reset: the configured permanent original CEO is missing, inactive, or no longer a CEO.",
      );
    }

    if (!dryRun) {
      // Maintenance must be offline. Locks also prevent a concurrent reservation
      // from slipping between the storage guard and deletion. No provider calls
      // are made while holding database locks, and this tool never revokes tokens.
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query(`LOCK TABLE ${[...new Set([...OPERATIONAL_TABLES_IN_DELETE_ORDER,...PRESERVED_TABLES.filter(t=>t!=="pgmigrations"),"cloud_storage_objects","cloud_storage_oauth_states"])].map(t=>`public.${t}`).join(",")} IN ACCESS EXCLUSIVE MODE`);
    }

    const before = await countRows(client, OPERATIONAL_TABLES_IN_DELETE_ORDER);

    const preservedBefore = await countRows(client, PRESERVED_TABLES);
    const files = [];
    for (const table of ["gate_pass_files", "employee_documents", "employee_profile_photos", "employee_contracts", "procurement_documents"]) {
      const rows = await client.query(`SELECT id, storage_key FROM public.${table} WHERE storage_key IS NOT NULL ORDER BY id`);
      files.push(...rows.rows.map(row => ({ table, ...row })));
    }
    const logo = (await client.query("SELECT value FROM cms_settings WHERE key='company.logo'")).rows[0]?.value;
    const preservedLogo = logo ? JSON.parse(logo).storageKey : null;
    const classified = new Set([...OPERATIONAL_TABLES_IN_DELETE_ORDER,...PRESERVED_TABLES,"cloud_storage_objects","cloud_storage_oauth_states"]);
    const unknown = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.filter(row=>!classified.has(row.tablename));
    if (unknown.length) throw new Error("Refusing reset: unclassified public tables require reset-tool review.");
    const objects = (await client.query("SELECT id, connection_id, kind, logical_path, provider_id, state, namespace, entity_id FROM cloud_storage_objects ORDER BY logical_path,id")).rows;
    const connections = (await client.query("SELECT provider,status,account_label,credentials IS NOT NULL AS has_credentials FROM cloud_storage_connections ORDER BY provider")).rows;
    const active = (await client.query("SELECT connection_id FROM cloud_storage_active WHERE singleton")).rows[0];
    if (dryRun) {
      console.log(JSON.stringify({ mode:"READ ONLY — no reset executed", target, originalCeo,
        remove: { ...before, users:preservedBefore.users-1, cloud_storage_oauth_states:(await countRows(client,["cloud_storage_oauth_states"])).cloud_storage_oauth_states },
        preserve: { ...preservedBefore, users:1 }, files, preservedLogo, cloudObjects:objects, connections,
        blockers: [
          ...(active?.connection_id ? ["Deactivate external storage before cleanup."] : []),
          ...(connections.some(c=>c.has_credentials) ? ["Resolve dependent files, then revoke personal connections through CMS."] : []),
          ...(files.length || objects.length ? ["Back up and reconcile the exact storage inventory before database deletion."] : []),
          "Review preserved reference/configuration rows; remove QA-only references explicitly before reset.",
          "A fresh verified backup and explicit execution approval are required."
        ] },null,2));
      await client.query("ROLLBACK");
      return;
    }
    if ((await client.query("SELECT 1 FROM user_permission_overrides WHERE user_id=$1 UNION ALL SELECT 1 FROM user_permission_bundle_assignments WHERE user_id=$1",[originalCeo.id])).rowCount) {
      throw new Error("Refusing reset: original CEO has individual authority assignments; review their preservation before resetting.");
    }
    if (preservedLogo?.startsWith("cloud:")) throw new Error("Refusing reset: retained branding depends on cloud storage; explicitly restore approved default branding before cleanup.");
    if ((await client.query("SELECT 1 FROM cloud_storage_connections WHERE credentials IS NOT NULL OR status<>'disconnected'")).rowCount ||
        (await client.query("SELECT 1 FROM cloud_storage_active WHERE connection_id IS NOT NULL")).rowCount ||
        (await client.query("SELECT 1 FROM cloud_storage_objects WHERE state<>'deleted'")).rowCount) {
      throw new Error("Refusing reset: cloud objects/connections require verified cleanup and disconnection first; no storage reference was removed.");
    }
    // Legacy cleanup must be confirmed by absence, not a never-throw remove().
    // Non-local providers require a separately verified cleanup workflow.
    const legacy = files.filter(file=>!file.storage_key.startsWith("cloud:"));
    if (legacy.length && process.env.STORAGE_PROVIDER !== "local") throw new Error("Refusing reset: legacy provider cleanup is not verified.");
    for (const file of legacy) {
      if (!process.env.STORAGE_DIR) throw new Error("STORAGE_DIR is required to verify local cleanup.");
      const root=path.resolve(process.env.STORAGE_DIR), resolved=path.resolve(root,file.storage_key);
      if (!resolved.startsWith(root+path.sep)) throw new Error("Unsafe local storage reference.");
      try { await fs.lstat(resolved); throw new Error("Refusing reset: referenced local files still exist; back up and clean the reviewed inventory first."); }
      catch(error) { if(error.code!=="ENOENT") throw error; }
    }
    if (process.env.ESDMS_RESET_BACKUP_CONFIRMED !== target.databaseName) throw new Error("Refusing reset: confirm the freshly verified backup with ESDMS_RESET_BACKUP_CONFIRMED.");
    await client.query("DELETE FROM cloud_storage_oauth_states");
    await client.query("DELETE FROM cloud_storage_objects");
    await client.query("UPDATE cloud_storage_connections SET updated_by_user_id=NULL,account_id=NULL,account_label=NULL,last_success_at=NULL,last_test_at=NULL,last_error=NULL,revision=revision+1");
    // Preserve delivery settings without retaining references to removed users.
    await client.query("UPDATE cms_settings SET updated_by_user_id=NULL WHERE updated_by_user_id<>$1",[originalCeo.id]);
    await client.query("UPDATE document_number_settings SET updated_by_user_id=NULL WHERE updated_by_user_id<>$1",[originalCeo.id]);

    for (const table of TABLES_WITH_PROTECTIVE_TRIGGERS) {
      await client.query(`ALTER TABLE public.${table} DISABLE TRIGGER USER`);
    }

    // All organization rows survive. The CEO identity and scope stay intact.

    for (const table of OPERATIONAL_TABLES_IN_DELETE_ORDER) {
      await client.query(`DELETE FROM public.${table}`);
    }

    await client.query("DELETE FROM users WHERE id <> $1", [originalCeo.id]);

    // Sites and organization/reference configuration are retained explicitly.
    // QA-only reference removal requires separate reviewed row identities.

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
    for (const table of PRESERVED_TABLES.filter(t=>t!=="users")) {
      if (preserved[table] !== preservedBefore[table]) throw new Error(`Preserved table changed: ${table}.`);
    }

    const survivor = await resolveOriginalCeo(client, originalCeoEmail);
    if (!survivor || survivor.id !== originalCeo.id) {
      throw new Error("Reset would have removed the permanent original CEO login.");
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
        + `${preserved.sites} sites, organization/CMS configuration, and the permanent original CEO login `
        + `${survivor.email}.`,
    );
    console.log("\nPreserved organization and CMS configuration remain available to the original CEO.");
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
