import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectSchemaCompatibility } from "../src/shared/db/schema-compatibility.js";

function executorWith(overrides = {}) {
  return {
    async query() {
      return {
        rows: [{
          applied_count: 36,
          latest_applied: "1787425000000_schema-readiness-diagnostics",
          expected_applied: true,
          required_column_present: true,
          rollback_trigger_present: true,
          eligibility_trigger_present: true,
          rollback_function_present: true,
          eligibility_function_present: true,
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
  ]) {
    const result = await inspectSchemaCompatibility(executorWith({ [missing]: false }));
    assert.equal(result.schemaCompatible, false, `${missing} must be required`);
  }

  assert.equal(
    (await inspectSchemaCompatibility(executorWith({ applied_count: 35 }))).schemaCompatible,
    false,
    "the complete expected migration level must be present",
  );
});
