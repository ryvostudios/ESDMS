import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectSchemaCompatibility } from "../src/shared/db/schema-compatibility.js";

// Fast unit coverage of the decision logic. The behaviour that actually
// matters — that a real restricted database role cannot be reported ready
// when it cannot serve — is covered against a real database in
// readiness-serving-contract.test.js; this file only pins down how the
// individual signals combine, including the combinations that are awkward to
// produce against a live server.

const HEALTHY_SCHEMA = {
  applied_count: 47,
  latest_applied: "1787436000000_cloud-storage",
  expected_applied: true,
  cloud_storage_columns_present: true,
  cms_columns_present: true,
  cms_audit_scope_trigger_present: true,
  required_column_present: true,
  rollback_trigger_present: true,
  eligibility_trigger_present: true,
  rollback_function_present: true,
  eligibility_function_present: true,
  permission_bundles_present: true,
  bundle_permissions_present: true,
  bundle_assignments_present: true,
  procurement_scope_present: true,
  drivers_present: true,
  vehicles_present: true,
  gate_pass_fleet_link_present: true,
  evidence_note_present: true,
  evidence_file_types_present: true,
  gate_pass_lifecycle_trigger_present: true,
  company_item_identity_index_present: true,
};

const HEALTHY_ACCESS = {
  schema_usable: true,
  missing_tables: [],
  missing_privileges: [],
  rls_disabled: [],
  missing_policies: [],
  missing_functions: [],
};

// The inspector issues three distinct statements against the executor: the
// schema-state query, the runtime-access query, and the real authentication
// profile projection. Routing on the SQL text keeps each independently
// controllable.
function executorWith({ schema = {}, access = {}, schemaThrows, servingThrows } = {}) {
  return {
    async query(sql) {
      if (sql.includes("esdms_schema_migration_state")) {
        if (schemaThrows) throw schemaThrows;
        return { rows: [{ ...HEALTHY_SCHEMA, ...schema }] };
      }
      if (sql.includes("has_schema_privilege")) {
        return { rows: [{ ...HEALTHY_ACCESS, ...access }] };
      }
      // The authentication profile projection.
      if (servingThrows) throw servingThrows;
      return { rows: [] };
    },
  };
}

function denied() {
  return Object.assign(new Error("permission denied"), { code: "42501" });
}

test("a healthy schema, healthy runtime access and a working auth path is ready", async () => {
  const result = await inspectSchemaCompatibility(executorWith());

  assert.equal(result.ready, true);
  assert.equal(result.schemaCompatible, true);
  assert.equal(result.runtimeAccessHealthy, true);
  assert.equal(result.authServingHealthy, true);
  assert.deepEqual(result.problems, []);
});

test("schema compatibility requires migration ledger and physical load-bearing objects", async () => {
  for (const missing of [
    "expected_applied",
    "required_column_present",
    "rollback_trigger_present",
    "eligibility_trigger_present",
    "rollback_function_present",
    "eligibility_function_present",
    "permission_bundles_present",
    "bundle_permissions_present",
    "bundle_assignments_present",
    "procurement_scope_present",
    // Fleet and gate evidence: a ledger row is not proof these exist.
    "drivers_present",
    "vehicles_present",
    "gate_pass_fleet_link_present",
    "evidence_note_present",
    "evidence_file_types_present",
    "gate_pass_lifecycle_trigger_present",
    "company_item_identity_index_present",
  ]) {
    const result = await inspectSchemaCompatibility(executorWith({ schema: { [missing]: false } }));
    assert.equal(result.schemaCompatible, false, `${missing} must be required`);
    assert.equal(result.ready, false, `${missing} must make the instance not ready`);
    assert.ok(result.problems.length > 0, `${missing} must be reported`);
  }

  const behind = await inspectSchemaCompatibility(executorWith({ schema: { applied_count: 41 } }));
  assert.equal(behind.schemaCompatible, false, "the complete expected migration level must be present");
  assert.ok(behind.problems.some((problem) => problem.includes("migration level 41")));
});

test("a correct schema is NOT ready when the runtime role cannot use it", async () => {
  // This combination is the whole reason this module was rewritten: every
  // object present, every privilege gone.
  const cases = [
    [{ schema_usable: false }, "USAGE on schema public"],
    [{ missing_tables: ["drivers"] }, "drivers"],
    [{ missing_privileges: ["users.SELECT"] }, "users.SELECT"],
    [{ rls_disabled: ["vehicles"] }, "vehicles"],
    [{ missing_policies: ["gate_passes"] }, "gate_passes"],
    [{ missing_functions: ["esdms_schema_migration_state(text)"] }, "esdms_schema_migration_state"],
  ];

  for (const [access, expected] of cases) {
    const result = await inspectSchemaCompatibility(executorWith({ access }));

    assert.equal(result.schemaCompatible, true, `${expected}: the schema itself is fine`);
    assert.equal(result.runtimeAccessHealthy, false, `${expected}: runtime access must fail`);
    assert.equal(result.ready, false, `${expected}: the instance must not be reported ready`);
    assert.ok(
      result.problems.some((problem) => problem.includes(expected)),
      `${expected}: must be named in the problems, got ${result.problems.join(" | ")}`,
    );
  }
});

test("a correct schema and correct grants is NOT ready when the auth path cannot execute", async () => {
  // The end-to-end backstop: if the declarative contract ever misses
  // something, executing the real authentication projection still catches it.
  const result = await inspectSchemaCompatibility(executorWith({ servingThrows: denied() }));

  assert.equal(result.schemaCompatible, true);
  assert.equal(result.runtimeAccessHealthy, true);
  assert.equal(result.authServingHealthy, false);
  assert.equal(result.ready, false);
  assert.ok(result.problems.some((problem) => problem.includes("authentication profile query")));
});

test("a denied schema-state query still yields a specific diagnosis, not an opaque failure", async () => {
  const result = await inspectSchemaCompatibility(
    executorWith({ schemaThrows: denied(), access: { missing_privileges: ["permissions.SELECT"] } }),
  );

  assert.equal(result.ready, false);
  assert.equal(result.schemaCompatible, false);
  assert.equal(result.appliedMigrationCount, null);
  assert.equal(result.latestAppliedMigration, null);
  assert.ok(result.problems.some((problem) => problem.includes("permissions.SELECT")));
});

test("problem summaries stay bounded and never carry database error text", async () => {
  const many = Array.from({ length: 30 }, (_, index) => `table_${String(index).padStart(2, "0")}.SELECT`);
  const result = await inspectSchemaCompatibility(executorWith({ access: { missing_privileges: many } }));

  const summary = result.problems.find((problem) => problem.includes("missing table privileges"));
  assert.ok(summary, "the missing privileges must be reported");
  assert.ok(summary.includes("(+22 more)"), `expected a truncated summary, got: ${summary}`);
  assert.ok(summary.length < 300, "a readiness problem must stay short enough to log and read");

  // Readiness is a public, unauthenticated endpoint: it may name schema
  // objects (already published in docs/SECURITY.md) but must never echo a
  // driver error, a stack frame, or a SQL fragment back to the caller.
  for (const problem of result.problems) {
    assert.ok(
      !/permission denied|ERROR:|\bat \w+ \(|\bFROM\b|\bWHERE\b/i.test(problem),
      `problem leaked raw detail: ${problem}`,
    );
  }
});

test("CMS scope trigger and metadata are load-bearing even when the migration ledger is current", async () => {
  for (const field of ["cms_columns_present", "cms_audit_scope_trigger_present", "cloud_storage_columns_present"]) {
    const result = await inspectSchemaCompatibility(executorWith({ schema: { [field]: false } }));
    assert.equal(result.ready, false);
    assert.equal(result.schemaCompatible, false);
  }
});
