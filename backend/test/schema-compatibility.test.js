import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectSchemaCompatibility } from "../src/shared/db/schema-compatibility.js";

function executorWith(overrides = {}) {
  return {
    async query() {
      return {
        rows: [{
          applied_count: 38,
          latest_applied: "1787427000000_driver-vehicle-master-and-gate-evidence",
          expected_applied: true,
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
          ...overrides,
        }],
      };
    },
  };
}

test("schema compatibility requires migration ledger and physical load-bearing objects", async () => {
  assert.equal((await inspectSchemaCompatibility(executorWith())).schemaCompatible, true);

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
  ]) {
    const result = await inspectSchemaCompatibility(executorWith({ [missing]: false }));
    assert.equal(result.schemaCompatible, false, `${missing} must be required`);
  }

  assert.equal(
    (await inspectSchemaCompatibility(executorWith({ applied_count: 37 }))).schemaCompatible,
    false,
    "the complete expected migration level must be present",
  );
});
