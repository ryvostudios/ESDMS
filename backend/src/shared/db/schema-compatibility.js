export const EXPECTED_MIGRATION = "1787426000000_governance-capability-bundles";
export const EXPECTED_MIGRATION_COUNT = 37;

// This is deliberately detection-only. A migration ledger entry is not proof
// that its load-bearing objects still exist, so readiness verifies both.
export async function inspectSchemaCompatibility(executor) {
  const result = await executor.query(
    `WITH migration_state AS (
       SELECT * FROM esdms_schema_migration_state($1)
     )
     SELECT
       migration_state.applied_count,
       migration_state.latest_applied,
       migration_state.expected_applied,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'material_demands'
           AND column_name = 'draft_delete_eligible'
           AND data_type = 'boolean'
           AND is_nullable = 'NO'
       ) AS required_column_present,
       EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'material_demands'
           AND t.tgname = 'material_demands_forbid_draft_rollback' AND NOT t.tgisinternal
       ) AS rollback_trigger_present,
       EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'material_demands'
           AND t.tgname = 'material_demands_set_draft_delete_eligible' AND NOT t.tgisinternal
       ) AS eligibility_trigger_present,
       to_regprocedure('public.material_demands_forbid_draft_rollback()') IS NOT NULL
         AS rollback_function_present,
       to_regprocedure('public.material_demands_set_draft_delete_eligible()') IS NOT NULL
         AS eligibility_function_present,
       to_regclass('public.permission_bundles') IS NOT NULL AS permission_bundles_present,
       to_regclass('public.permission_bundle_permissions') IS NOT NULL AS bundle_permissions_present,
       to_regclass('public.user_permission_bundle_assignments') IS NOT NULL AS bundle_assignments_present,
       EXISTS (SELECT 1 FROM permissions WHERE code = 'procurement.site_scope') AS procurement_scope_present
     FROM migration_state`,
    [EXPECTED_MIGRATION],
  );

  const state = result.rows[0];
  const schemaCompatible = Boolean(
    state.expected_applied &&
      state.applied_count >= EXPECTED_MIGRATION_COUNT &&
      state.required_column_present &&
      state.rollback_trigger_present &&
      state.eligibility_trigger_present &&
      state.rollback_function_present &&
      state.eligibility_function_present &&
      state.permission_bundles_present &&
      state.bundle_permissions_present &&
      state.bundle_assignments_present &&
      state.procurement_scope_present,
  );

  return {
    expectedMigration: EXPECTED_MIGRATION,
    expectedMigrationCount: EXPECTED_MIGRATION_COUNT,
    appliedMigrationCount: state.applied_count,
    latestAppliedMigration: state.latest_applied || null,
    schemaCompatible,
  };
}
